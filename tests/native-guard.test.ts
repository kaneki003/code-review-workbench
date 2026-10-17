import { afterEach, expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const binary = resolve('native/build/Release/crw_guard.node');
const native = createRequire(import.meta.url)(binary) as {
  processIdentity(pid: number): { pid: number; start: string } | null;
  assertLocalDirectory(path: string): void;
};
const directories: string[] = [];
const children: ChildProcess[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('killing an owner lets exactly one of two competing processes obtain the OS guard', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-death-')));
  directories.push(directory);
  const lockPath = join(directory, 'guard');
  const owner = await startContender(lockPath);
  expect(owner.status).toBe('held');
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const contenders = await Promise.all([startContender(lockPath), startContender(lockPath)]);
  expect(contenders.map((contender) => contender.status).sort()).toEqual(['busy', 'held']);
});

test('terminating a worker releases its guard while the enclosing process remains alive', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-worker-death-')));
  directories.push(directory);
  const lockPath = join(directory, 'guard');
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const native = require(workerData.binary);
    const guard = native.tryAcquire(workerData.lockPath);
    parentPort.postMessage(guard ? 'held' : 'busy');
    parentPort.on('message', () => native.release(guard));
  `,
    { eval: true, workerData: { binary, lockPath } },
  );
  workers.push(worker);
  expect((await once(worker, 'message'))[0]).toBe('held');
  expect((await startContender(lockPath)).status).toBe('busy');
  await worker.terminate();
  expect((await startContender(lockPath)).status).toBe('held');
});

async function startContender(lockPath: string) {
  const child = fork(resolve('tests/fixtures/native-guard-process.cjs'), [binary, lockPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let errors = '';
  child.stderr!.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  const status = await new Promise<string>((resolveStatus, reject) => {
    child.once('message', (message: { status: string }) => resolveStatus(message.status));
    child.once('exit', () => reject(new Error(`Guard contender exited: ${errors}`)));
    child.once('error', reject);
  });
  return { child, status };
}

async function send(child: ChildProcess, action: string) {
  const response = once(child, 'message');
  child.send(action);
  return (await response)[0] as { status: string };
}

test('competing processes hold one guard; release and stale release cannot unlock its successor', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-native-')));
  directories.push(directory);
  const lockPath = join(directory, 'guard');
  const first = await startContender(lockPath);
  expect(first.status).toBe('held');
  const second = await startContender(lockPath);
  expect(second.status).toBe('busy');
  expect(await send(first.child, 'release')).toEqual({ status: 'released' });
  expect(await send(second.child, 'acquire')).toEqual({ status: 'held' });
  expect(await send(first.child, 'release')).toEqual({ status: 'already-released' });
  expect((await startContender(lockPath)).status).toBe('busy');
});

test('OS process-start identity distinguishes a child and no longer identifies it after death', async () => {
  const identity = native.processIdentity(process.pid);
  expect(identity).toMatchObject({ pid: process.pid, start: expect.any(String) });
  expect(identity!.start.length).toBeGreaterThan(0);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-identity-')));
  directories.push(directory);
  const owner = await startContender(join(directory, 'guard'));
  const childIdentity = native.processIdentity(owner.child.pid!);
  expect(childIdentity).toMatchObject({ pid: owner.child.pid, start: expect.any(String) });
  expect(childIdentity).not.toEqual(identity);
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  expect(native.processIdentity(owner.child.pid!)).not.toEqual(childIdentity);
});

test('local-directory validation refuses a redirected directory before guard creation', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-local-root-')));
  directories.push(directory);
  expect(() => native.assertLocalDirectory(directory)).not.toThrow();
  const link = join(directory, 'redirect');
  await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => native.assertLocalDirectory(link)).toThrow();
  expect(() => native.assertLocalDirectory('relative/path')).toThrow();
});

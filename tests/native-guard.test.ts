import { afterEach, expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve('native/build/Release/crw_guard.node');
const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
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
  const directory = await mkdtemp(join(tmpdir(), 'crw-native-'));
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

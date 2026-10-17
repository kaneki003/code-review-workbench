import { afterEach, expect, test } from 'vitest';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  rm,
  symlink,
  realpath,
  readFile,
  readdir,
  rename,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const binary = resolve('native/build/Release/crw_guard.node');
const native = createRequire(import.meta.url)(binary) as {
  processIdentity(pid: number): { pid: number; start: string } | null;
  assertLocalDirectory(path: string): void;
  ensurePrivateDirectory(path: string): boolean;
  publishRecord(path: string, text: string, failure?: string): void;
  tryAcquire(path: string): object | null;
  assertHeld(handle: object): void;
  release(handle: object): boolean;
  prepareChild(
    executable: string,
    args: string[],
    directory: string,
    environment: Record<string, string>,
    operationId: string,
  ): { pid: number };
  startChild(handle: object): number;
  pollChild(handle: object): { settled: boolean; exitCode?: number };
  closeChild(handle: object): void;
  cancelPreparedChild(handle: object): void;
};
const directories: string[] = [];
const children: ChildProcess[] = [];
const workers: Worker[] = [];

test('cancelling a prepared child proves it stopped without permitting its effect', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-cancel-child-')));
  directories.push(directory);
  const marker = join(directory, 'forbidden');
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[0].includes('='),
    ),
  );
  const child = native.prepareChild(
    process.execPath,
    ['-e', "require('node:fs').writeFileSync(process.argv[1],'unsafe')", marker],
    directory,
    environment,
    randomUUID(),
  );
  try {
    native.cancelPreparedChild(child);
    let state = native.pollChild(child);
    for (let attempt = 0; !state.settled && attempt < 200; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      state = native.pollChild(child);
    }
    expect(state.settled).toBe(true);
    expect(state.exitCode).not.toBe(0);
    expect(() => native.startChild(child)).toThrow();
    await expect(access(marker)).rejects.toThrow();
  } finally {
    native.closeChild(child);
  }
});

test.each(['write', 'file-flush', 'rename', 'directory-flush'])(
  'record %s failure never acknowledges publication or leaves a partial record',
  async (failure) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-record-fault-')));
    directories.push(directory);
    const records = join(directory, 'records');
    native.ensurePrivateDirectory(records);
    const record = join(records, 'control.json');
    native.publishRecord(record, '{"version":1}');
    expect(() => native.publishRecord(record, '{"version":2}', failure)).toThrowError(
      expect.objectContaining({
        code: ['write', 'file-flush'].includes(failure) ? 'RECORD_FLUSH' : 'RECORD_PUBLICATION',
      }),
    );
    expect(await readFile(record, 'utf8')).toBe(
      failure === 'directory-flush' ? '{"version":2}' : '{"version":1}',
    );
    expect(await readdir(records)).toEqual(['control.json']);
  },
);

test('a prepared child has a verified identity and cannot act until its exact handle is started', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-child-gate-')));
  directories.push(directory);
  const marker = join(directory, 'effect');
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const child = native.prepareChild(
    process.execPath,
    ['-e', "require('node:fs').writeFileSync(process.argv[1], 'done')", marker],
    directory,
    environment,
    randomUUID(),
  );
  try {
    expect(native.processIdentity(child.pid)).toMatchObject({
      pid: child.pid,
      start: expect.any(String),
    });
    await expect(access(marker)).rejects.toThrow();
    native.startChild(child);
    expect(() => native.startChild(child)).toThrow();
    let result = native.pollChild(child);
    for (let attempt = 0; !result.settled && attempt < 200; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      result = native.pollChild(child);
    }
    expect(result).toEqual({ settled: true, exitCode: 0 });
    expect(await readFile(marker, 'utf8')).toBe('done');
  } finally {
    native.closeChild(child);
  }
});

test.skipIf(process.platform === 'win32')(
  'the child gate works when the host standard descriptors are closed',
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-closed-stdio-')));
    directories.push(directory);
    execFileSync(
      process.execPath,
      [
        '-e',
        `
    const fs = require('node:fs');
    const native = require(process.argv[1]);
    const directory = process.argv[2];
    for (let fd = 0; fd < 3; fd++) fs.closeSync(fd);
    const child = native.prepareChild(process.execPath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1], 'done')", directory + '/effect'],
      directory, process.env, require('node:crypto').randomUUID());
    native.startChild(child);
    const timer = setInterval(() => {
      const status = native.pollChild(child);
      if (status.settled) {
        fs.writeFileSync(directory + '/result', JSON.stringify(status));
        native.closeChild(child); clearInterval(timer);
      }
    }, 10);
  `,
        binary,
        directory,
      ],
      { timeout: 5000 },
    );
    expect(JSON.parse(await readFile(join(directory, 'result'), 'utf8'))).toEqual({
      settled: true,
      exitCode: 0,
    });
    expect(await readFile(join(directory, 'effect'), 'utf8')).toBe('done');
  },
);

test('a replaced guard pathname invalidates the original handle before another write', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-guard-replaced-')));
  directories.push(directory);
  const path = join(directory, 'guard');
  const handle = native.tryAcquire(path)!;
  try {
    expect(() => native.assertHeld(handle)).not.toThrow();
    if (process.platform !== 'win32') {
      await rename(path, join(directory, 'old-guard'));
      expect(() => native.assertHeld(handle)).toThrow();
    }
  } finally {
    native.release(handle);
  }
  expect(() => native.assertHeld(handle)).toThrow();
});

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

test('independent recovery records publish complete replacement files in a private directory', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-record-')));
  directories.push(directory);
  const recovery = join(directory, 'recovery');
  expect(native.ensurePrivateDirectory(recovery)).toBe(true);
  expect(native.ensurePrivateDirectory(recovery)).toBe(false);
  const record = join(recovery, 'control.json');
  native.publishRecord(record, '{"phase":"owned","fence":1}');
  expect(await readFile(record, 'utf8')).toBe('{"phase":"owned","fence":1}');
  native.publishRecord(record, '{"phase":"released","fence":1}');
  expect(await readFile(record, 'utf8')).toBe('{"phase":"released","fence":1}');
  expect(await readdir(recovery)).toEqual(['control.json']);
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

test.runIf(process.platform === 'darwin')(
  'macOS process identity uses the invariant boot session identifier',
  () => {
    const bootSession = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
    }).trim();
    expect(native.processIdentity(process.pid)!.start).toContain(bootSession);
  },
);

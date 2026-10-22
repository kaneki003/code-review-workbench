import { expect, test, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, cp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { ReviewManager } from '../../src/application/review-manager';
import { probeGit } from '../../src/git/readiness';
import { probeNativeGuard } from '../../src/native/readiness';

test('successful native verification can finish bounded cleanup after the initial deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crw-native-cleanup-'));
  const worker = join(directory, 'probe.cjs');
  try {
    await build({
      entryPoints: ['src/native/probe-worker.ts'],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      banner: {
        // The real helper still performs every OS check and removes its files.
        // Delays model one second of startup plus 4.5 seconds of Windows cleanup.
        js: `const fixtureFs=require('node:fs');const fixtureRemove=fixtureFs.rmSync;
             fixtureFs.rmSync=(...args)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4500);return fixtureRemove(...args);};
             Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);`,
      },
    });
    await cp(resolve('native/build/Release/crw_guard.node'), join(directory, 'native-guard.node'));
    const check = await probeNativeGuard(worker);
    expect(check.status, check.detail).toBe('passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('repeated cleanup progress cannot extend the cleanup deadline or acknowledge success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crw-native-stalled-cleanup-'));
  const worker = join(directory, 'probe.cjs');
  try {
    await writeFile(
      worker,
      `const {parentPort}=require('node:worker_threads');
       setInterval(()=>parentPort.postMessage({stage:'cleanup'}),25);`,
    );
    const check = await probeNativeGuard(worker);
    expect(check).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('cleanup timed out after five seconds; stage: cleanup'),
    });
    expect(check.detail).toContain('Check again.');
    expect(check.detail).not.toContain('Install the VSIX');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('worker errors retain their queued failure phase and code without leaking worker text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crw-native-failure-'));
  const worker = join(directory, 'probe.cjs');
  try {
    await writeFile(
      worker,
      `require('node:worker_threads').parentPort.postMessage({stage:'cleanup'});
       const error=new Error('private worker text');error.code='EPERM';throw error;`,
    );
    for (let attempt = 0; attempt < 20; attempt++) {
      const check = await probeNativeGuard(worker);
      expect(check.status).toBe('blocked');
      expect(check.detail).toContain('worker error: EPERM; stage: cleanup');
      expect(check.detail).not.toContain('private worker text');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('native readiness distinguishes an unresponsive worker from a native load failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crw-native-timeout-'));
  const worker = join(directory, 'probe.cjs');
  try {
    await writeFile(worker, `setInterval(()=>{},1000);`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = probeNativeGuard(worker);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('timed out after five seconds'),
    });
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

test('public readiness loads the real native helper in a worker and keeps review ownership blocked', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-native-readiness-')));
  try {
    execFileSync('git', ['-C', directory, 'init', '--quiet']);
    const worker = join(directory, 'native-probe-worker.cjs');
    await build({
      entryPoints: ['src/native/probe-worker.ts'],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    });
    await cp(resolve('native/build/Release/crw_guard.node'), join(directory, 'native-guard.node'));
    const manager = new ReviewManager({
      environment: () => ({
        vscode: '1.142.0',
        node: process.versions.node,
        electron: undefined,
        chrome: undefined,
        platform: process.platform,
        arch: process.arch,
        desktop: true,
        trusted: true,
        remote: undefined,
        folders: [{ scheme: 'file', path: directory }],
      }),
      git: probeGit,
      sqlite: async () => ({
        id: 'sqlite',
        label: 'SQLite',
        status: 'blocked',
        detail: 'Separate probe',
      }),
      native: () => probeNativeGuard(worker),
    });
    const report = await manager.checkReadiness();
    expect(report.checks.find((check) => check.id === 'guard')).toMatchObject({ status: 'passed' });
    expect(report.checks.find((check) => check.id === 'ownership')?.status).toBe('blocked');
    expect(report.reviewAvailable).toBe(false);
    await rm(join(directory, 'native-guard.node'));
    expect(await probeNativeGuard(worker)).toMatchObject({ status: 'blocked' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

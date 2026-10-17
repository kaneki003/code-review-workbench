import { expect, test } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtemp, cp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { ReviewManager } from '../src/application/review-manager';
import { probeGit } from '../src/connections/git-readiness';
import { probeNativeGuard } from '../src/connections/native-readiness';

test('public readiness loads the real native helper in a worker and keeps review ownership blocked', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-native-readiness-')));
  try {
    execFileSync('git', ['-C', directory, 'init', '--quiet']);
    const worker = join(directory, 'native-probe-worker.cjs');
    await build({
      entryPoints: ['src/connections/native-probe-worker.ts'],
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

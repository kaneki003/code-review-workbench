import { expect, test } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ReviewManager } from '../src/application/review-manager';
import { probeSqlite } from '../src/connections/sqlite-readiness';
import { probeGit } from '../src/connections/git-readiness';

test('passing Git and real SQLite probes still block review ownership without opening a disk store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crw-worker-'));
  const worker = join(directory, 'readiness-worker.cjs');
  try {
    execFileSync('git', ['-C', directory, 'init', '--quiet']);
    await build({
      entryPoints: ['src/connections/readiness-worker.ts'],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    });
    const manager = new ReviewManager({
      environment: () => ({
        vscode: '1.142.0',
        node: process.versions.node,
        electron: undefined,
        chrome: undefined,
        platform: 'darwin',
        arch: 'arm64',
        desktop: true,
        trusted: true,
        remote: undefined,
        folders: [{ scheme: 'file', path: directory }],
      }),
      git: probeGit,
      native: async () => ({
        id: 'guard',
        label: 'Helper',
        status: 'blocked',
        detail: 'Separate probe',
      }),
      sqlite: () => probeSqlite(worker),
    });
    const report = await manager.checkReadiness();
    expect(report.checks.find((check) => check.id === 'git')?.status).toBe('passed');
    expect(report.checks.find((check) => check.id === 'sqlite')).toMatchObject({
      status: 'passed',
      detail: expect.stringContaining('In-memory parameterized transaction and rollback passed'),
    });
    expect(report.checks.find((check) => check.id === 'ownership')).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('extension update'),
    });
    expect((await readdir(directory)).sort()).toEqual(['.git', 'readiness-worker.cjs']);
    expect(report.reviewAvailable).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

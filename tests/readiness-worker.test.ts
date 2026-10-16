import { expect, test } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReviewManager } from '../src/application/review-manager';
import { probeSqlite } from '../src/connections/sqlite-readiness';

test('the public readiness action probes real worker transactions without opening a disk store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crw-worker-'));
  const worker = join(directory, 'readiness-worker.cjs');
  try {
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
      git: async () => ({ id: 'git', label: 'Git', status: 'blocked', detail: 'No repository' }),
      sqlite: () => probeSqlite(worker),
    });
    const report = await manager.checkReadiness();
    expect(report.checks.find((check) => check.id === 'sqlite')).toMatchObject({
      status: 'passed',
      detail: expect.stringContaining('In-memory parameterized transaction and rollback passed'),
    });
    expect(await readdir(directory)).toEqual(['readiness-worker.cjs']);
    expect(report.reviewAvailable).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

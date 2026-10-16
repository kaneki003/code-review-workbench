import { expect, test, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewManager, type HostEnvironment } from '../src/application/review-manager';
import { probeGit } from '../src/connections/git-readiness';
import { probeSqlite } from '../src/connections/sqlite-readiness';

const local: HostEnvironment = {
  vscode: '1.142.0', node: '24.21.0', electron: '43.7.7', chrome: '150.0.7871.250',
  platform: 'darwin', arch: 'arm64', desktop: true, trusted: true,
  remote: undefined, folders: [{ scheme: 'file', path: '/unused' }],
};

test('a remote workspace explains the limitation before executing local probes', async () => {
  const manager = new ReviewManager({
    environment: () => ({ ...local, remote: 'ssh-remote' }),
    git: async () => { throw new Error('Git must not execute'); },
    sqlite: async () => { throw new Error('Worker must not execute'); },
  });
  const report = await manager.checkReadiness();
  expect(report.checks.find(c => c.id === 'workspace')).toMatchObject({
    status: 'blocked', detail: expect.stringContaining('local desktop'),
  });
  expect(report.reviewAvailable).toBe(false);
  expect(report.checks.map(c => c.id)).not.toContain('git');
  expect(report.checks.map(c => c.id)).not.toContain('sqlite');
});

test.each([
  { trusted: false }, { desktop: false }, { folders: [] },
  { folders: [{ scheme: 'vscode-remote', path: '/remote' }] },
  { folders: [{ scheme: 'file', path: '/one' }, { scheme: 'file', path: '/two' }] },
  { vscode: '1.141.1' }, { node: '22.21.0' }, { platform: 'darwin', arch: 'x64' },
])('unsupported setup %j skips all local probes', async override => {
  const manager = new ReviewManager({
    environment: () => ({ ...local, ...override }),
    git: async () => { throw new Error('Git must not execute'); },
    sqlite: async () => { throw new Error('Worker must not execute'); },
  });
  const report = await manager.checkReadiness();
  expect(report.checks.map(c => c.id)).not.toContain('git');
  expect(report.checks.map(c => c.id)).not.toContain('sqlite');
  expect(report.checks.find(c => c.id === 'probes')?.status).toBe('blocked');
});

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('a missing repository is explained without cloning or starting a review', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crw-readiness-'));
  directories.push(folder);
  const manager = new ReviewManager({
    environment: () => ({ ...local, folders: [{ scheme: 'file', path: folder }] }),
    git: probeGit,
    sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: 'Available' }),
  });
  const report = await manager.checkReadiness();
  expect(report.checks.find(c => c.id === 'git')).toMatchObject({ status: 'blocked', detail: expect.stringContaining('already-cloned') });
  expect(report.reviewAvailable).toBe(false);
  // The repository remains absent after checking it.
  expect(() => execFileSync('git', ['-C', folder, 'rev-parse', '--git-dir'], { stdio: 'pipe' })).toThrow();
});

test('checking a dirty repository retains the files, index and refs and keeps ownership pending', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crw-readiness-'));
  directories.push(folder);
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  git('init', '--quiet');
  await writeFile(join(folder, 'file.txt'), 'staged\n');
  git('add', 'file.txt');
  await writeFile(join(folder, 'file.txt'), 'unstaged\n');
  const index = await readFile(join(folder, '.git/index'));
  const refs = git('for-each-ref');
  const manager = new ReviewManager({
    environment: () => ({ ...local, folders: [{ scheme: 'file', path: folder }] }), git: probeGit,
    sqlite: () => probeSqlite(join(folder, 'missing-worker.cjs')),
  });
  const report = await manager.checkReadiness();
  expect(report.checks.find(c => c.id === 'git')?.status).toBe('passed');
  expect(report.checks.find(c => c.id === 'sqlite')?.status).toBe('blocked');
  expect(report.checks.find(c => c.id === 'ownership')?.status).toBe('pending');
  expect(await readFile(join(folder, '.git/index'))).toEqual(index);
  expect(await readFile(join(folder, 'file.txt'), 'utf8')).toBe('unstaged\n');
  expect(git('for-each-ref')).toBe(refs);
});

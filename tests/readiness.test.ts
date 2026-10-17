import { expect, test, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewManager, type HostEnvironment } from '../src/application/review-manager';
import { probeGit } from '../src/connections/git-readiness';
import { probeSqlite } from '../src/connections/sqlite-readiness';

const supportedHost: HostEnvironment = {
  vscode: '1.142.0',
  node: '24.21.0',
  electron: '43.7.7',
  chrome: '150.0.7871.250',
  platform: 'darwin',
  arch: 'arm64',
  desktop: true,
  trusted: true,
  remote: undefined,
  folders: [{ scheme: 'file', path: '/unused' }],
};

test('a remote workspace explains the limitation before executing local probes', async () => {
  const manager = new ReviewManager({
    environment: () => ({ ...supportedHost, remote: 'ssh-remote' }),
    git: async () => {
      throw new Error('Git must not execute');
    },
    sqlite: async () => {
      throw new Error('Worker must not execute');
    },
  });
  const report = await manager.checkReadiness();
  expect(report.checks.find((check) => check.id === 'workspace')).toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('local desktop'),
  });
  expect(report.reviewAvailable).toBe(false);
  expect(report.checks.map((check) => check.id)).not.toContain('git');
  expect(report.checks.map((check) => check.id)).not.toContain('sqlite');
});

const unsupportedHosts: { name: string; changes: Partial<HostEnvironment> }[] = [
  { name: 'untrusted folder', changes: { trusted: false } },
  { name: 'browser VS Code', changes: { desktop: false } },
  { name: 'no open folder', changes: { folders: [] } },
  { name: 'virtual folder', changes: { folders: [{ scheme: 'vscode-remote', path: '/remote' }] } },
  {
    name: 'multiple workspace folders',
    changes: {
      folders: [
        { scheme: 'file', path: '/one' },
        { scheme: 'file', path: '/two' },
      ],
    },
  },
  { name: 'VS Code below the minimum version', changes: { vscode: '1.141.1' } },
  { name: 'Node 22 instead of Node 24', changes: { node: '22.21.0' } },
  { name: 'unsupported Intel Mac', changes: { platform: 'darwin', arch: 'x64' } },
];

test.each(unsupportedHosts)('$name skips all local probes', async ({ changes }) => {
  const manager = new ReviewManager({
    environment: () => ({ ...supportedHost, ...changes }),
    git: async () => {
      throw new Error('Git must not execute');
    },
    sqlite: async () => {
      throw new Error('Worker must not execute');
    },
  });
  const report = await manager.checkReadiness();
  expect(report.checks.map((check) => check.id)).not.toContain('git');
  expect(report.checks.map((check) => check.id)).not.toContain('sqlite');
  expect(report.checks.find((check) => check.id === 'probes')?.status).toBe('blocked');
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('a missing repository is explained without cloning or starting a review', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crw-readiness-'));
  temporaryDirectories.push(folder);
  const manager = new ReviewManager({
    environment: () => ({ ...supportedHost, folders: [{ scheme: 'file', path: folder }] }),
    git: probeGit,
    sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: 'Available' }),
  });
  const report = await manager.checkReadiness();
  expect(report.checks.find((check) => check.id === 'git')).toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('already-cloned'),
  });
  expect(report.reviewAvailable).toBe(false);
  // The repository remains absent after checking it.
  expect(() =>
    execFileSync('git', ['-C', folder, 'rev-parse', '--git-dir'], { stdio: 'pipe' }),
  ).toThrow();
});

test('checking a dirty repository retains the files, index and refs while ownership is blocked', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'crw-readiness-'));
  temporaryDirectories.push(folder);
  const runGit = (...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  runGit('init', '--quiet');
  await writeFile(join(folder, 'file.txt'), 'staged\n');
  runGit('add', 'file.txt');
  await writeFile(join(folder, 'file.txt'), 'unstaged\n');
  const originalIndex = await readFile(join(folder, '.git/index'));
  const originalRefs = runGit('for-each-ref');
  const manager = new ReviewManager({
    environment: () => ({ ...supportedHost, folders: [{ scheme: 'file', path: folder }] }),
    git: probeGit,
    sqlite: () => probeSqlite(join(folder, 'missing-worker.cjs')),
  });
  const report = await manager.checkReadiness();
  expect(report.checks.find((check) => check.id === 'git')?.status).toBe('passed');
  expect(report.checks.find((check) => check.id === 'sqlite')?.status).toBe('blocked');
  expect(report.checks.find((check) => check.id === 'ownership')).toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('extension update'),
  });
  expect(await readFile(join(folder, '.git/index'))).toEqual(originalIndex);
  expect(await readFile(join(folder, 'file.txt'), 'utf8')).toBe('unstaged\n');
  expect(runGit('for-each-ref')).toBe(originalRefs);
});

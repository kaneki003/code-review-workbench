import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRepositoryConnection } from '../src/connections/local-repository';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('local identity uses every safe GitHub remote and server repository IDs, not aliases', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'crw-local-repository-'));
  directories.push(repository);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '--quiet');
  git('remote', 'add', 'origin', 'https://token@github.com/attacker/wrong.git');
  git('remote', 'add', 'fork-copy', 'git@github.com:contributor/export-service.git');
  git('remote', 'add', 'canonical', 'https://github.com/acme/export-service.git');
  const resolveRepository = vi.fn(async (owner: string) => ({
    id: owner === 'acme' ? '3001' : '4001',
    name: 'export-service',
    fullName: `${owner}/export-service`,
  }));
  const connection = createLocalRepositoryConnection({
    resolvePullRequest: vi.fn(),
    resolveRepository,
  });

  await expect(connection.inspect(repository)).resolves.toEqual({
    path: repository,
    repositoryIds: ['3001', '4001'],
    transport: 'ssh',
  });
  expect(resolveRepository).toHaveBeenCalledTimes(2);
  expect(resolveRepository).not.toHaveBeenCalledWith('attacker', 'wrong');
});

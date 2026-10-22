import { expect, test, vi } from 'vitest';

import { readFile, rename } from 'node:fs/promises';

import { join, resolve } from 'node:path';

import { fork } from 'node:child_process';

import { createLocalRepositoryConnection } from '../../src/git/repository';

import { fixture, overviewFixture, repositoryFixture } from '../support/storage/shared-store';
test('an account owner durably saves a verified PR candidate and local registration', async () => {
  const context = await fixture();
  const { repository: location, git } = await repositoryFixture(context.directory);
  git('remote', 'add', 'fork-copy', 'git@github.com:fork/export-service.git');
  const actor = { host: 'github.com' as const, userId: '1001' };
  const pullRequest = {
    id: '9001',
    number: 248,
    title: 'Keep exports deterministic',
    body: 'Author description.',
    state: 'open' as const,
    draft: false,
    url: 'https://github.com/acme/export-service/pull/248',
    author: { userId: '2001', login: 'author' },
    base: {
      repository: { id: '3001', fullName: 'acme/export-service' },
      ref: 'main',
      oid: 'a'.repeat(40),
    },
    head: {
      repository: { id: '4001', fullName: 'fork/export-service' },
      ref: 'feature',
      oid: 'b'.repeat(40),
    },
  };
  const review = {
    github: {
      resolvePullRequest: async () => ({
        status: 'ready' as const,
        account: { ...actor, login: 'reviewer' },
        pullRequest,
        repositories: [
          {
            identity: pullRequest.head.repository,
            remote: { owner: 'fork', repository: 'export-service', transport: 'ssh' as const },
          },
        ],
      }),
      sessionChanged() {},
    },
    repository: createLocalRepositoryConnection(),
  };
  const first = context.manager('repository', 'data-A', actor, (connection) => connection, review);

  const firstOverview = await first.openPullRequestOverview(pullRequest.url);
  expect(firstOverview, JSON.stringify(firstOverview)).toMatchObject({
    status: 'ready',
    localRepository: { repositoryId: '4001', relation: 'head' },
  });
  await first.releasePrivateStore();
  const second = context.manager('repository', 'data-A', actor, (connection) => connection, review);
  await second.openPrivateStore();
  await expect(second.readSavedPullRequest('3001', 248)).resolves.toMatchObject({
    account: actor,
    pullRequest,
    localRepository: {
      repositoryId: '4001',
      relation: 'head',
      facts: {
        worktree: { path: location },
        gitDirectory: { path: join(location, '.git') },
        commonDirectory: { path: join(location, '.git') },
      },
    },
  });
  // Reuse of the same fork name is a different immutable repository. It cannot
  // overwrite the mapping or carry old private data into that repository.
  pullRequest.head.repository.id = '4999';
  await expect(second.openPullRequestOverview(pullRequest.url)).resolves.toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('previously registered'),
  });
  await expect(second.readSavedPullRequest('3001', 248)).resolves.toMatchObject({
    localRepository: { repositoryId: '4001' },
    pullRequest: { head: { repository: { id: '4001' } } },
  });
  await second.releasePrivateStore();
  actor.userId = '1002';
  const other = context.manager('repository', 'data-A', actor, (connection) => connection, review);
  await expect(other.openPullRequestOverview(pullRequest.url)).resolves.toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('previously registered'),
  });
  await expect(other.readSavedPullRequest('3001', 248)).resolves.toBeUndefined();
});

test('API access loss preserves a saved candidate and the exact local index, files and refs', async () => {
  const context = await overviewFixture();
  const index = await readFile(join(context.repository, '.git', 'index'));
  const refs = context.git('show-ref');
  const files = await readFile(join(context.repository, 'tracked.txt'));
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
  context.state.failure = 404;
  await expect(context.manager.openPullRequestOverview(context.url)).resolves.toMatchObject({
    status: 'unavailable',
    detail: expect.stringContaining('private'),
  });
  await expect(context.manager.readSavedPullRequest('3001', 248)).resolves.toMatchObject({
    pullRequest: { body: 'Saved private work' },
    account: { userId: '1001' },
  });
  expect(await readFile(join(context.repository, '.git', 'index'))).toEqual(index);
  expect(await readFile(join(context.repository, 'tracked.txt'))).toEqual(files);
  expect(context.git('show-ref')).toBe(refs);
});

test('first-time sign-in can finish after the provider announces its new session', async () => {
  const context = await overviewFixture();
  context.state.duringConsent = () => {
    context.manager.handleGitHubSessionChange(true);
  };
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
});

test('first registration requires explicit confirmation and a retained mapping avoids reconfirmation', async () => {
  const context = await overviewFixture();
  context.state.confirm = false;
  await expect(context.manager.openPullRequestOverview(context.url)).resolves.toMatchObject({
    status: 'local-required',
    detail: expect.stringContaining('confirmation'),
  });
  await expect(context.manager.readSavedPullRequest('3001', 248)).resolves.toBeUndefined();
  context.state.confirm = true;
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
  context.state.confirm = false;
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
});

test('replacing a registered Git directory cannot silently inherit the local mapping', async () => {
  const context = await overviewFixture();
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
  await rename(join(context.repository, '.git'), join(context.repository, 'prior-git-directory'));
  context.git('init', '--quiet');
  context.git('remote', 'add', 'same-alias', 'git@github.com:fork/export-service.git');
  await expect(context.manager.openPullRequestOverview(context.url)).resolves.toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('directory identities'),
  });
  await expect(context.manager.readSavedPullRequest('3001', 248)).resolves.toMatchObject({
    localRepository: { repositoryId: '4001' },
  });
});

test('adding an upstream remote retains the explicit fork registration', async () => {
  const context = await overviewFixture();
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
  context.git('remote', 'add', 'upstream', 'https://github.com/acme/export-service.git');
  await expect(context.manager.openPullRequestOverview(context.url)).resolves.toMatchObject({
    status: 'ready',
    localRepository: { repositoryId: '4001', relation: 'head' },
  });
});

test('a changed actor cannot inherit the old scope and explicit release permits a separate account', async () => {
  const context = await overviewFixture();
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
  context.state.userId = 1002;
  context.manager.handleGitHubSessionChange(false);
  await expect(context.manager.openPullRequestOverview(context.url)).resolves.toMatchObject({
    status: 'blocked',
    detail: expect.stringContaining('another GitHub account'),
  });
  expect((await context.manager.inspectPrivateStore()).status).toBe('owned');
  expect((await context.manager.releasePrivateStore()).status).toBe('closed');
  expect((await context.manager.openPullRequestOverview(context.url)).status).toBe('ready');
  const saved = await context.manager.readSavedPullRequest('3001', 248);
  expect(saved?.account.userId).toBe('1002');
  expect(JSON.stringify(saved)).not.toContain('synthetic-token-outside-records');
});

test('a superseded target cannot save a late PR result', async () => {
  const context = await overviewFixture();
  let finish!: () => void;
  let began = false;
  context.state.delayed = async () => {
    began = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const old = context.manager.openPullRequestOverview(context.url);
  await vi.waitFor(() => expect(began).toBe(true));
  context.state.failure = 404;
  const current = context.manager.openPullRequestOverview(context.url);
  finish();
  await expect(old).resolves.toMatchObject({ status: 'stale' });
  await expect(current).resolves.toMatchObject({ status: 'unavailable' });
  expect((await context.manager.inspectPrivateStore()).status).toBe('closed');
});

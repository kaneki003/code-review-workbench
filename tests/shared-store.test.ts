import { afterEach, expect, test, vi } from 'vitest';
import { build } from 'esbuild';
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  symlink,
  link,
  rename,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ReviewManager, type ReviewConnections } from '../src/application/review-manager';
import { createStoreConnection } from '../src/connections/shared-store';
import type {
  StoreConfiguration,
  StoreConnection,
  StoreRequest,
  StoreReply,
} from '../src/application/private-store';
import type { StoreView } from '../src/application/private-store';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { StorageDiagnostics } from '../src/connections/storage-diagnostics';
import { createRequire } from 'node:module';
import { createGitHubConnection } from '../src/connections/github';
import { createLocalRepositoryConnection } from '../src/connections/local-repository';
import type { NativeStore } from '../src/connections/store-records';

// One integration case builds its fixture, starts real hosts/workers and runs
// several Git/durable-file actions. Windows can exceed Vitest's 5s default.
// This bounds the whole case; production request/Git/SQLite deadlines stay intact.
const integrationTimeout = process.platform === 'win32' ? 30_000 : 15_000;
if (process.platform === 'win32') vi.setConfig({ testTimeout: integrationTimeout });

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-store-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const worker = join(directory, 'store-worker.cjs');
  await build({
    entryPoints: ['src/connections/store-worker.ts'],
    outfile: worker,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
  });
  await cp(resolve('native/build/Release/crw_guard.node'), join(directory, 'native-guard.node'));
  const processPath = join(directory, 'store-process.cjs');
  await build({
    entryPoints: ['tests/fixtures/store-process.ts'],
    outfile: processPath,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
  });
  async function contender(name: string, data = 'data-A', diagnostics?: StorageDiagnostics) {
    const child = fork(
      processPath,
      [
        worker,
        JSON.stringify({
          osHome: home,
          candidateRoot: join(home, data),
          windowId: name,
          location: join(directory, name),
        }),
        ...(diagnostics ? [JSON.stringify(diagnostics)] : []),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, HOME: join(directory, name), USERPROFILE: join(directory, name) },
      },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    });
    await once(child, 'message');
    let sequence = 0;
    type Action =
      | 'open'
      | 'release'
      | 'renew'
      | 'inspect'
      | 'reserve-child'
      | 'prepare-ref'
      | 'recover'
      | 'execute-ref';
    const pending = new Map<number, (reply: StoreReply) => void>();
    child.on('message', (reply: StoreReply & { id: number }) => {
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
    function reply(action: Action, args?: string[]): Promise<StoreReply> {
      const id = ++sequence;
      return new Promise((resolveReply) => {
        pending.set(id, resolveReply);
        child.send({ id, action, ref: args?.[0], oid: args?.[1] });
      });
    }
    return {
      child,
      reply,
      async send(action: Action, args?: string[]) {
        return (await reply(action, args)).view;
      },
    };
  }
  const connections = new Map<string, StoreConnection>();
  function manager(
    name: string,
    data = 'data-A',
    actor?: StoreConfiguration['actor'],
    wrap: (connection: StoreConnection) => StoreConnection = (connection) => connection,
    review: Pick<ReviewConnections, 'github' | 'repository' | 'confirmLocalRepository'> = {},
  ) {
    const store = wrap(
      createStoreConnection(worker, {
        osHome: home,
        candidateRoot: join(home, data),
        windowId: name,
        location: join(directory, name),
        ...(actor ? { actor } : {}),
      }),
    );
    connections.set(name, store);
    cleanups.push(() => store.dispose());
    return new ReviewManager({
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
        folders: [{ scheme: 'file', path: join(directory, name) }],
      }),
      git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: 'Separate probe' }),
      sqlite: async () => ({
        id: 'sqlite',
        label: 'SQLite',
        status: 'passed',
        detail: 'Separate probe',
      }),
      native: async () => ({
        id: 'guard',
        label: 'Helper',
        status: 'passed',
        detail: 'Separate probe',
      }),
      store,
      confirmLocalRepository: async () => true,
      ...(actor ? { account: actor } : {}),
      ...review,
    });
  }
  return { directory, home, worker, manager, connections, contender };
}

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

async function overviewFixture() {
  const context = await fixture();
  const { repository, git, oid } = await repositoryFixture(context.directory);
  git('remote', 'add', 'arbitrary-alias', 'git@github.com:fork/export-service.git');
  const state = {
    confirm: true,
    userId: 1001,
    failure: 0,
    headId: 4001,
    delayed: undefined as undefined | (() => Promise<void>),
    duringConsent: undefined as undefined | (() => void),
  };
  const github = createGitHubConnection({
    getSession: async () => {
      state.duringConsent?.();
      return { accessToken: 'synthetic-token-outside-records' };
    },
    fetch: async (input) => {
      const url = String(input);
      if (state.failure)
        return new Response('{}', {
          status: state.failure,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/pulls/')) await state.delayed?.();
      const data = url.endsWith('/user')
        ? { id: state.userId, login: 'reviewer' }
        : url.includes('/pulls/')
          ? {
              id: 9001,
              number: 248,
              title: 'Verified candidate',
              body: 'Saved private work',
              state: 'open',
              merged: false,
              draft: false,
              html_url: 'https://github.com/acme/export-service/pull/248',
              user: { id: 2001, login: 'author' },
              base: { ref: 'main', sha: oid, repo: { id: 3001, full_name: 'acme/export-service' } },
              head: {
                ref: 'feature',
                sha: oid,
                repo: { id: state.headId, full_name: 'fork/export-service' },
              },
            }
          : {
              id: url.includes('/fork/') ? state.headId : 3001,
              full_name: url.includes('/fork/') ? 'fork/export-service' : 'acme/export-service',
            };
      return new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const manager = context.manager('repository', 'data-A', undefined, (connection) => connection, {
    github,
    repository: createLocalRepositoryConnection(),
    confirmLocalRepository: async () => state.confirm,
  });
  return {
    ...context,
    repository,
    git,
    manager,
    state,
    url: 'https://github.com/acme/export-service/pull/248',
  };
}

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

async function repositoryFixture(directory: string) {
  const repository = join(directory, 'repository');
  await mkdir(repository);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repository,
        '-c',
        `core.hooksPath=${join(directory, 'fixture-no-hooks')}`,
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init');
  await writeFile(join(repository, 'tracked.txt'), 'original\n');
  git('add', 'tracked.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture',
  );
  return { repository, git, oid: git('rev-parse', 'HEAD').trim() };
}

test.each(['HEAD', 'index', 'files'])(
  'a changed %s refuses a prepared Git effect and preserves repository work',
  async (change) => {
    const context = await fixture();
    const { repository, git, oid } = await repositoryFixture(context.directory);
    const manager = context.manager('repository');
    await manager.openPrivateStore();
    const prepared = await manager.prepareReferenceUpdate('refs/code-review-workbench/check', oid);
    expect(prepared.operation?.phase, JSON.stringify(prepared)).toBe('prepared');
    if (change === 'HEAD')
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'external',
      );
    if (change === 'index') git('update-index', '--skip-worktree', 'tracked.txt');
    if (change === 'files') await writeFile(join(repository, 'tracked.txt'), 'external\n');
    const result = await manager.executeRepositoryOperation(prepared.operation!.id);
    expect(result.operation, JSON.stringify(result)).toMatchObject({
      phase: 'observed',
      outcome: 'refused',
    });
    expect(() => git('rev-parse', '--verify', 'refs/code-review-workbench/check')).toThrow();
    if (change === 'files')
      expect(await readFile(join(repository, 'tracked.txt'), 'utf8')).toBe('external\n');
    expect(await manager.releasePrivateStore()).toMatchObject({ status: 'closed' });
  },
);

test.each(
  ['refs', 'logs', 'hardlinked-log'].flatMap((target) =>
    ['before prepare', 'after prepare'].map((stage) => [target, stage] as const),
  ),
)('redirected %s %s cannot write outside the recorded Git directory', async (target, stage) => {
  const context = await fixture();
  const { repository, git, oid } = await repositoryFixture(context.directory);
  const external = join(context.directory, 'external');
  await mkdir(external);
  const marker = join(external, 'marker');
  await writeFile(marker, 'preserve');
  const ref = 'refs/code-review-workbench/redirected';
  const owner = context.manager('repository');
  await owner.openPrivateStore();
  const earlier =
    stage === 'after prepare' ? await owner.prepareReferenceUpdate(ref, oid) : undefined;
  if (earlier) expect(earlier.operation?.phase).toBe('prepared');
  if (target === 'hardlinked-log') {
    await mkdir(join(repository, '.git', 'logs', 'refs', 'code-review-workbench'), {
      recursive: true,
    });
    await link(marker, join(repository, '.git', 'logs', ref));
  } else {
    const parent = join(repository, '.git', ...(target === 'logs' ? ['logs', 'refs'] : ['refs']));
    await mkdir(parent, { recursive: true });
    await symlink(
      external,
      join(parent, 'code-review-workbench'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const prepared = earlier
    ? await owner.executeRepositoryOperation(earlier.operation!.id)
    : await owner.prepareReferenceUpdate(ref, oid);
  expect(prepared.operation, JSON.stringify(prepared)).toBeUndefined();
  expect(prepared.view.status).toBe('recovery');
  expect(await readFile(marker, 'utf8')).toBe('preserve');
  expect(() => git('rev-parse', '--verify', ref)).toThrow();
});

test('Git hooks and arbitrary reference targets cannot start hidden child processes', async () => {
  const context = await fixture();
  const { repository, oid } = await repositoryFixture(context.directory);
  await writeFile(
    join(repository, '.git', 'hooks', 'reference-transaction'),
    '#!/bin/sh\necho unsafe > hook-ran\n',
    { mode: 0o755 },
  );
  const manager = context.manager('repository');
  await manager.openPrivateStore();
  expect((await manager.prepareReferenceUpdate('refs/heads/main', oid)).view).toMatchObject({
    status: 'recovery',
    code: 'INVALID_OPERATION',
  });
  const prepared = await manager.prepareReferenceUpdate(
    'refs/code-review-workbench/hook-check',
    oid,
  );
  const result = await manager.executeRepositoryOperation(prepared.operation!.id);
  expect(result.operation, JSON.stringify(result)).toMatchObject({ outcome: 'applied' });
  await expect(readFile(join(repository, 'hook-ran'))).rejects.toThrow();
  expect(await manager.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('a lost acknowledgment after the outcome commit is reconciled from Git and its independent receipt', async () => {
  const context = await fixture();
  const { git, oid } = await repositoryFixture(context.directory);
  const owner = await context.contender('repository', 'data-A', {
    boundary: 'observed.commit.after',
    mode: 'crash',
  });
  expect(await owner.send('open')).toMatchObject({ status: 'owned' });
  const plan = await owner.reply('prepare-ref', ['refs/code-review-workbench/lost-ack', oid]);
  expect(plan.operation?.phase).toBe('prepared');
  expect((await owner.reply('execute-ref')).view.status).toBe('recovery');
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const next = context.manager('repository', 'data-B');
  expect(await next.openPrivateStore()).toMatchObject({ status: 'recovery' });
  const recovered = await next.recoverPrivateStore();
  expect(recovered.view, JSON.stringify(recovered)).toMatchObject({ status: 'closed' });
  expect(recovered.operation).toMatchObject({ outcome: 'applied' });
  expect(await next.openPrivateStore()).toMatchObject({ status: 'owned' });
  expect((await next.inspectRepositoryOperation(plan.operation!.id)).operation).toMatchObject({
    outcome: 'applied',
  });
  expect(
    git('reflog', 'show', '--format=%H', 'refs/code-review-workbench/lost-ack').trim().split('\n'),
  ).toEqual([oid]);
  expect(await next.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

const operationFailures: StorageDiagnostics[] = [
  ...['prepared', 'armed', 'observed'].flatMap((phase) =>
    ['record', 'barrier', 'commit', 'ack'].flatMap((step) =>
      ['before', 'after'].map((edge) => ({
        boundary: `${phase}.${step}.${edge}`,
        mode: 'crash' as const,
      })),
    ),
  ),
  { boundary: 'dispatch.before', mode: 'crash' },
  { boundary: 'dispatch.after', mode: 'crash' },
  ...['prepared', 'armed', 'observed'].map((phase) => ({
    boundary: `${phase}.commit.before`,
    mode: 'commit' as const,
  })),
  ...['prepared', 'observed'].flatMap((phase) =>
    (['write', 'file-flush', 'rename', 'directory-flush'] as const).map((stage) => ({
      boundary: `${phase}.record`,
      mode: 'native' as const,
      stage,
    })),
  ),
  { boundary: 'dispatch.after', mode: 'error' },
];
test.each(operationFailures)(
  'failure at $boundary ($mode $stage) never replays Git or acknowledges an uncertain result',
  async (diagnostics) => {
    const context = await fixture();
    const { repository, git, oid } = await repositoryFixture(context.directory);
    const index = await readFile(join(repository, '.git', 'index'));
    const owner = await context.contender('repository', 'data-A', diagnostics);
    expect(await owner.send('open')).toMatchObject({ status: 'owned' });
    const ref = 'refs/code-review-workbench/failure';
    const plan = await owner.reply('prepare-ref', [ref, oid]);
    const response = diagnostics.boundary.startsWith('prepared.')
      ? plan
      : await owner.reply('execute-ref');
    expect(response.view.status, JSON.stringify({ diagnostics, response })).toBe('recovery');
    expect(response.operation).toBeUndefined();
    const exited = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await exited;
    const next = context.manager('repository', 'data-B');
    const opened = await next.openPrivateStore();
    expect(['owned', 'recovery']).toContain(opened.status);
    if (opened.status === 'recovery') {
      let receipt = await next.recoverPrivateStore();
      for (let attempt = 0; receipt.view.status === 'recovery' && attempt < 60; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        receipt = await next.recoverPrivateStore();
      }
      expect(receipt.view, JSON.stringify({ diagnostics, receipt })).toMatchObject({
        status: 'closed',
      });
      expect(await next.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
    }
    let actual: string | null = null;
    try {
      actual = git('rev-parse', '--verify', ref).trim();
    } catch {
      /* absent is a known outcome */
    }
    expect([null, oid]).toContain(actual);
    if (
      diagnostics.boundary.startsWith('prepared.') ||
      diagnostics.boundary.startsWith('armed.') ||
      diagnostics.boundary === 'dispatch.before'
    )
      expect(actual).toBeNull();
    if (diagnostics.boundary.startsWith('observed.')) expect(actual).toBe(oid);
    if (plan.operation) {
      const receipt = await next.inspectRepositoryOperation(plan.operation.id);
      expect(receipt.operation, JSON.stringify({ diagnostics, receipt })).toMatchObject({
        phase: 'observed',
        outcome: actual === oid ? 'applied' : 'not-applied',
      });
    }
    if (actual === oid)
      expect(git('reflog', 'show', '--format=%H', ref).trim().split('\n')).toEqual([oid]);
    expect(git('rev-parse', 'HEAD').trim()).toBe(oid);
    expect(await readFile(join(repository, '.git', 'index'))).toEqual(index);
    expect(await readFile(join(repository, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(await next.releasePrivateStore()).toMatchObject({ status: 'closed' });
  },
  integrationTimeout,
);

test(
  'a recorded Git child outliving its host blocks recovery until its process group settles',
  async () => {
    const context = await fixture();
    const { repository, git, oid } = await repositoryFixture(context.directory);
    const native = createRequire(import.meta.url)(
      resolve('native/build/Release/crw_guard.node'),
    ) as NativeStore;
    const owner = await context.contender('repository', 'data-A', {
      boundary: 'dispatch.after',
      mode: 'error',
    });
    expect(await owner.send('open')).toMatchObject({ status: 'owned' });
    const ref = 'refs/code-review-workbench/survivor';
    await mkdir(join(repository, '.git', 'refs', 'code-review-workbench'), { recursive: true });
    const plan = await owner.reply('prepare-ref', [ref, oid]);
    const lock = join(repository, '.git', 'refs', 'code-review-workbench', 'survivor.lock');
    await writeFile(lock, 'fixture-owned lock');
    expect((await owner.reply('execute-ref')).view).toMatchObject({
      status: 'recovery',
      code: 'INJECTED_IO',
    });
    const record = JSON.parse(
      await readFile(
        join(context.home, '.code-review-workbench', `operation-${plan.operation!.id}.json`),
        'utf8',
      ),
    );
    const exited = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await exited;
    const next = context.manager('repository', 'data-B');
    expect(await next.openPrivateStore()).toMatchObject({ status: 'recovery' });
    if (process.platform !== 'win32') {
      expect(native.processIdentity(record.child.pid)).toEqual(record.child);
      expect((await next.recoverPrivateStore()).view).toMatchObject({ status: 'recovery' });
    }
    // Only remove the lock created by this fixture, never a Git-owned lock.
    await rm(lock);
    let receipt = await next.recoverPrivateStore();
    for (let attempt = 0; receipt.view.status === 'recovery' && attempt < 160; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      receipt = await next.recoverPrivateStore();
    }
    expect(receipt.view, JSON.stringify(receipt)).toMatchObject({ status: 'closed' });
    expect(native.childGroupSettled(record.child.pid, record.id)).toBe(true);
    if (process.platform !== 'win32') {
      expect(receipt.operation?.outcome).toBe('applied');
      expect(git('reflog', 'show', '--format=%H', ref).trim().split('\n')).toEqual([oid]);
    } else expect(receipt.operation?.outcome).toBe('not-applied');
  },
  integrationTimeout,
);

test('one manager opens the durable store; a second sees only its location and later claims the same store', async () => {
  const context = await fixture();
  const first = context.manager('first');
  const second = context.manager('second', 'data-B');
  const owned = await first.openPrivateStore();
  expect(owned.status, JSON.stringify(owned)).toBe('owned');
  expect(owned).toMatchObject({ status: 'owned', root: join(context.home, 'data-A'), fence: 1 });
  expect(owned.process).toMatchObject({ pid: process.pid, start: expect.any(String) });
  const busy = await second.openPrivateStore();
  expect(busy).toMatchObject({ status: 'busy', ownerLocation: join(context.directory, 'first') });
  expect(busy).not.toHaveProperty('scopeId');
  expect(busy).not.toHaveProperty('token');
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const next = await second.openPrivateStore();
  expect(next).toMatchObject({
    status: 'owned',
    root: owned.root,
    storeId: owned.storeId,
    incarnation: owned.incarnation,
    scopeId: owned.scopeId,
    fence: 2,
  });
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('host configuration uses OS account home despite process home overrides and rejects relative data roots', async () => {
  const context = await fixture();
  const resolver = join(context.directory, 'location.cjs');
  await build({
    entryPoints: ['src/connections/store-location.ts'],
    outfile: resolver,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const run = (extra: NodeJS.ProcessEnv = {}) =>
    execFileSync(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify(require(process.argv[1]).resolveStoreConfiguration(process.argv[2])))',
        resolver,
        context.directory,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: context.home, USERPROFILE: context.home, ...extra },
      },
    );
  expect(JSON.parse(run()).osHome).toBe(userInfo().homedir);
  if (process.platform === 'linux') expect(() => run({ XDG_DATA_HOME: 'relative/data' })).toThrow();
  if (process.platform === 'win32') expect(() => run({ LOCALAPPDATA: 'relative/data' })).toThrow();
});

test('workspace aliases identify the same actual folder while a different folder is refused', async () => {
  const context = await fixture();
  const original = join(context.directory, 'original');
  const other = join(context.directory, 'other');
  await mkdir(original);
  await mkdir(other);
  const alias = join(context.directory, 'alias');
  await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let selected =
    process.platform === 'win32'
      ? original[0] === original[0]!.toLowerCase()
        ? original[0]!.toUpperCase() + original.slice(1)
        : original[0]!.toLowerCase() + original.slice(1)
      : alias;
  const owner = context.manager('original', 'data-A', undefined, (connection) => ({
    ...connection,
    request: (request) => connection.request({ ...request, workspacePath: selected }),
  }));
  const opened = await owner.openPrivateStore();
  expect(opened.status, JSON.stringify(opened)).toBe('owned');
  selected = alias;
  expect(await owner.renewOwnership()).toMatchObject({ status: 'owned' });
  selected = other;
  expect(await owner.renewOwnership()).toMatchObject({
    status: 'recovery',
    code: 'WORKSPACE_CHANGED',
  });
  selected = original;
  expect(await owner.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('a typed reference update checks repository facts, records its outcome and permits release', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  const oid = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const manager = context.manager('repository');
  expect(await manager.openPrivateStore()).toMatchObject({ status: 'owned' });
  const plan = await manager.prepareReferenceUpdate('refs/code-review-workbench/test', oid);
  expect(plan.operation, JSON.stringify(plan)).toMatchObject({ phase: 'prepared' });
  expect(() =>
    execFileSync(
      'git',
      ['-C', repository, 'rev-parse', '--verify', 'refs/code-review-workbench/test'],
      { stdio: 'pipe' },
    ),
  ).toThrow();
  const result = await manager.executeRepositoryOperation(plan.operation!.id);
  expect(result.operation, JSON.stringify(result)).toMatchObject({
    phase: 'observed',
    outcome: 'applied',
    exitCode: 0,
  });
  expect(
    execFileSync('git', ['-C', repository, 'rev-parse', 'refs/code-review-workbench/test'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe(oid);
  expect(await manager.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('recovery cancels an undispatched operation after its host dies without replaying it', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  const oid = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const owner = await context.contender('repository');
  expect(await owner.send('open')).toMatchObject({ status: 'owned' });
  expect(
    await owner.send('prepare-ref', ['refs/code-review-workbench/recovery', oid]),
  ).toMatchObject({ status: 'recovery' });
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const next = context.manager('repository', 'data-B');
  expect(await next.openPrivateStore()).toMatchObject({ status: 'recovery' });
  const reconciled = await next.recoverPrivateStore();
  expect(reconciled.view, JSON.stringify(reconciled)).toMatchObject({ status: 'closed' });
  expect(reconciled.operation).toMatchObject({ phase: 'observed', outcome: 'not-applied' });
  expect(() =>
    execFileSync(
      'git',
      ['-C', repository, 'rev-parse', '--verify', 'refs/code-review-workbench/recovery'],
      { stdio: 'pipe' },
    ),
  ).toThrow();
  expect(await next.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
  expect(await next.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('the current owner can recover a prepared operation and release without replay', async () => {
  const context = await fixture();
  const { git, oid } = await repositoryFixture(context.directory);
  const owner = context.manager('repository');
  expect(await owner.openPrivateStore()).toMatchObject({ status: 'owned' });
  const prepared = await owner.prepareReferenceUpdate('refs/code-review-workbench/cancel', oid);
  expect(prepared.operation?.phase).toBe('prepared');
  const recovered = await owner.recoverPrivateStore();
  expect(recovered.view, JSON.stringify(recovered)).toMatchObject({ status: 'closed' });
  expect(recovered.operation).toMatchObject({ phase: 'observed', outcome: 'not-applied' });
  expect(() => git('rev-parse', '--verify', 'refs/code-review-workbench/cancel')).toThrow();
  expect(await owner.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
  expect((await owner.inspectRepositoryOperation(prepared.operation!.id)).operation).toEqual(
    recovered.operation,
  );
  expect(await owner.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('another account cannot inspect a retained operation receipt', async () => {
  const context = await fixture();
  const { oid } = await repositoryFixture(context.directory);
  const first = context.manager('repository', 'data-A', { host: 'github.com', userId: '1001' });
  await first.openPrivateStore();
  const prepared = await first.prepareReferenceUpdate('refs/code-review-workbench/private', oid);
  expect((await first.executeRepositoryOperation(prepared.operation!.id)).operation?.outcome).toBe(
    'applied',
  );
  await first.releasePrivateStore();
  const second = context.manager('repository', 'data-B', { host: 'github.com', userId: '1002' });
  expect(await second.openPrivateStore()).toMatchObject({ status: 'owned' });
  const response = await second.inspectRepositoryOperation(prepared.operation!.id);
  expect(response.view).toMatchObject({ status: 'recovery', code: 'OPERATION_UNAVAILABLE' });
  expect(response.operation).toBeUndefined();
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('an unchanged reference is refused before creating an ambiguous recovery intent', async () => {
  const context = await fixture();
  const { git, oid } = await repositoryFixture(context.directory);
  const ref = 'refs/code-review-workbench/unchanged';
  git('update-ref', ref, oid);
  const owner = context.manager('repository');
  await owner.openPrivateStore();
  const prepared = await owner.prepareReferenceUpdate(ref, oid);
  expect(prepared.view, JSON.stringify(prepared)).toMatchObject({
    status: 'recovery',
    code: 'INVALID_OPERATION',
  });
  expect(prepared.operation).toBeUndefined();
  expect(await owner.releasePrivateStore()).toMatchObject({ status: 'closed' });
  expect(git('rev-parse', '--verify', ref).trim()).toBe(oid);
});

test('restoring an older database cannot roll back the independent ownership generation', async () => {
  const context = await fixture();
  const first = context.manager('first');
  const opened = await first.openPrivateStore();
  await first.releasePrivateStore();
  const database = join(opened.root!, 'review.sqlite');
  const snapshot = join(context.directory, 'older.sqlite');
  await cp(database, snapshot);
  const next = context.manager('next');
  expect(await next.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
  await next.releasePrivateStore();
  await cp(snapshot, database);
  const restored = await readFile(database);
  expect(await context.manager('after-restore').openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'RECOVERY_REQUIRED',
  });
  expect(await readFile(database)).toEqual(restored);
});

test('an older writer refuses a newer SQLite schema without replacing it', async () => {
  const context = await fixture();
  const owner = context.manager('owner');
  const opened = await owner.openPrivateStore();
  await owner.releasePrivateStore();
  const database = join(opened.root!, 'review.sqlite');
  execFileSync(process.execPath, [
    '-e',
    "const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]); db.exec('PRAGMA user_version=2'); db.close();",
    database,
  ]);
  const newer = await readFile(database);
  expect(await context.manager('older-writer').openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'NEWER_SCHEMA',
  });
  expect(await readFile(database)).toEqual(newer);
});

test('real processes with different home and data variables never register a second store', async () => {
  const context = await fixture();
  const first = await context.contender('first');
  const second = await context.contender('second', 'data-B');
  const results = await Promise.all([first.send('open'), second.send('open')]);
  expect(results.filter((view) => view.status === 'owned').length).toBeLessThanOrEqual(1);
  expect(results.every((view) => ['owned', 'busy', 'recovery'].includes(view.status))).toBe(true);
  const winner = results.findIndex((view) => view.status === 'owned');
  if (winner === -1) {
    // Creating a permanent guard and acquiring its OS lock are separate OS
    // calls. A contender can win the lock first; explicit recovery is allowed,
    // but neither process may invent a store after that uncertain publication.
    expect(results.every((view) => view.status === 'recovery')).toBe(true);
    for (const path of [
      '.code-review-workbench/store-location.json',
      'data-A/review.sqlite',
      'data-B/review.sqlite',
    ])
      await expect(readFile(join(context.home, path))).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  const registered = JSON.parse(
    await readFile(join(context.home, '.code-review-workbench', 'store-location.json'), 'utf8'),
  );
  expect(results[winner]!.root).toBe(registered.root);
  expect(await [first, second][winner]!.send('release')).toMatchObject({ status: 'closed' });
});

test('after host death only one of two reclaimers obtains the next generation', async () => {
  const context = await fixture();
  const owner = await context.contender('owner');
  expect(await owner.send('open')).toMatchObject({ status: 'owned', fence: 1 });
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const first = await context.contender('first', 'data-B');
  const second = await context.contender('second', 'data-C');
  const results = await Promise.all([first.send('open'), second.send('open')]);
  expect(results.map((view) => view.status).sort()).toEqual(['busy', 'owned']);
  expect(results.find((view) => view.status === 'owned')!.fence).toBe(2);
});

test('worker death with a still-live host refuses takeover, even with an ancient heartbeat', async () => {
  const context = await fixture();
  const owner = context.manager('owner');
  expect(await owner.openPrivateStore()).toMatchObject({ status: 'owned' });
  await context.connections.get('owner')!.dispose();
  const path = join(context.home, '.code-review-workbench', 'control.json');
  const control = JSON.parse(await readFile(path, 'utf8'));
  control.owner.heartbeat = 1;
  await writeFile(path, JSON.stringify(control));
  expect(await context.manager('second').openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'RECOVERY_REQUIRED',
  });
});

test('handoff opens only the named window, and a failed handoff stays closed to everyone else', async () => {
  const context = await fixture();
  const first = context.manager('first');
  const opened = await first.openPrivateStore();
  expect(opened.status).toBe('owned');
  const offered = await first.offerStoreHandoff('second');
  expect(offered.view.status).toBe('closed');
  expect(offered.handoff).toBeDefined();
  const intruder = context.manager('third');
  expect(await intruder.openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'HANDOFF_PENDING',
  });
  const second = context.manager('second');
  expect(await second.openPrivateStore(offered.handoff)).toMatchObject({
    status: 'owned',
    fence: 2,
    storeId: opened.storeId,
  });
  expect(await first.renewOwnership()).toMatchObject({ status: 'recovery', code: 'STALE_LEASE' });
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('repository intent records sorted linked-worktree scopes and blocks every further mutation', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  const linked = join(context.directory, 'linked');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  execFileSync('git', ['-C', repository, 'worktree', 'add', '-b', 'linked', linked]);
  const manager = context.manager('linked');
  expect(await manager.openPrivateStore()).toMatchObject({ status: 'owned' });
  const [first, second] = await Promise.all([
    manager.recordRepositoryIntent(),
    manager.recordRepositoryIntent(),
  ]);
  expect(first.reservation?.scopes).toHaveLength(2);
  expect(first.reservation!.scopes).toEqual([...first.reservation!.scopes].sort());
  expect(
    first.reservation!.scopes.some((scope) => scope.endsWith(':' + join(repository, '.git'))),
  ).toBe(true);
  expect(first.reservation!.scopes.some((scope) => scope.endsWith(':' + linked))).toBe(true);
  expect(second.view.status).toBe('recovery');
  expect(second.reservation).toBeUndefined();
  expect(await manager.releasePrivateStore()).toMatchObject({ status: 'recovery' });
  expect((await manager.offerStoreHandoff('second')).view.status).toBe('recovery');
});

test('a changed store identity fences queued repository intent before acknowledging it', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  const manager = context.manager('repository', 'data-A', undefined, (connection) => ({
    ...connection,
    async request(request) {
      if (request.action === 'recordIntent') {
        const path = join(context.home, '.code-review-workbench', 'store-location.json');
        const record = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...record, incarnation: randomUUID() }));
      }
      return connection.request(request);
    },
  }));
  expect(await manager.openPrivateStore()).toMatchObject({ status: 'owned' });
  expect((await manager.recordRepositoryIntent()).view).toMatchObject({ status: 'recovery' });
  expect(() => execFileSync('git', ['-C', repository, 'config', '--local', 'crw.test'])).toThrow();
});

test('GitHub accounts have stable separate scopes and share the same OS-user exclusion', async () => {
  const context = await fixture();
  const first = context.manager('first', 'data-A', { host: 'github.com', userId: '1001' });
  const second = context.manager('second', 'data-B', { host: 'github.com', userId: '1002' });
  const owned = await first.openPrivateStore();
  const busy = await second.openPrivateStore();
  expect(Object.keys(busy).sort()).toEqual(['detail', 'ownerLocation', 'status']);
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const other = await second.openPrivateStore();
  expect(other.scopeId).not.toBe(owned.scopeId);
  expect(other.storeId).toBe(owned.storeId);
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
  expect(await first.openPrivateStore()).toMatchObject({
    status: 'owned',
    scopeId: owned.scopeId,
    fence: 3,
  });
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('an acknowledged intent survives host death and a live fixture child; no takeover after it finishes', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  await writeFile(
    join(repository, 'child.cjs'),
    `
    const fs = require('node:fs');
    fs.writeFileSync('child-started', String(process.pid));
    setTimeout(() => {
      require('node:child_process').execFileSync('git', ['config', '--local', 'crw.child', 'survived']);
      fs.writeFileSync('child-done', 'done');
    }, 1500);
  `,
  );
  const owner = await context.contender('repository');
  expect(await owner.send('open')).toMatchObject({ status: 'owned' });
  expect(await owner.send('reserve-child')).toMatchObject({
    status: 'recovery',
    code: 'OPERATION_PENDING',
  });
  await waitForFile(join(repository, 'child-started'));
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const next = context.manager('second');
  expect(await next.openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'RECOVERY_REQUIRED',
  });
  await waitForFile(join(repository, 'child-done'));
  expect(
    execFileSync('git', ['-C', repository, 'config', '--local', 'crw.child'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe('survived');
  expect(await context.manager('third').openPrivateStore()).toMatchObject({ status: 'recovery' });
});

test('orphan registration, corrupt database and newer protocol are preserved for recovery', async () => {
  const orphan = await fixture();
  await mkdir(join(orphan.home, '.code-review-workbench'), { mode: 0o700 });
  expect(await orphan.manager('orphan').openPrivateStore()).toMatchObject({ status: 'recovery' });
  const context = await fixture();
  const first = context.manager('first');
  const opened = await first.openPrivateStore();
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const database = join(opened.root!, 'review.sqlite');
  await writeFile(database, 'damaged database');
  expect(await context.manager('second').openPrivateStore()).toMatchObject({ status: 'recovery' });
  expect(await readFile(database, 'utf8')).toBe('damaged database');
  const newer = await fixture();
  const owner = newer.manager('owner');
  expect(await owner.openPrivateStore()).toMatchObject({ status: 'owned' });
  expect(await owner.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const registry = join(newer.home, '.code-review-workbench', 'store-location.json');
  const future = { ...JSON.parse(await readFile(registry, 'utf8')), protocol: 2 };
  await writeFile(registry, JSON.stringify(future));
  expect(await newer.manager('old-version').openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'NEWER_PROTOCOL',
  });
  expect(JSON.parse(await readFile(registry, 'utf8'))).toEqual(future);
});

test('a retried request commits once, and an old callback cannot release its successor', async () => {
  const context = await fixture();
  let old: StoreRequest;
  const first = context.manager('first', 'data-A', undefined, (connection) => ({
    ...connection,
    async request(request) {
      const reply = await connection.request(request);
      if (request.action === 'renew' || request.action === 'release') {
        expect(await connection.request(request)).toEqual(reply);
        old = request;
      }
      return reply;
    },
  }));
  const opened = await first.openPrivateStore();
  const saved = await first.renewOwnership();
  expect(saved).toMatchObject({ status: 'owned', revision: opened.revision! + 1 });
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const second = context.manager('second');
  expect(await second.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
  // Replaying the old release receipt cannot close the new owner's OS handle.
  await context.connections.get('first')!.request(old!);
  expect(await context.manager('third').openPrivateStore()).toMatchObject({ status: 'busy' });
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

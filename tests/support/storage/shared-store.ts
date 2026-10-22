import { afterEach, test, vi } from 'vitest';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReviewManager, type ReviewConnections } from '../../../src/application/review-manager';
import { createStoreConnection } from '../../../src/storage/connection';
import type {
  StoreConfiguration,
  StoreConnection,
  StoreReply,
} from '../../../src/storage/contracts';

import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';

import type { StorageDiagnostics } from '../../../src/storage/diagnostics';

import { createGitHubConnection } from '../../../src/github/pull-requests';
import { createLocalRepositoryConnection } from '../../../src/git/repository';

// One integration case builds its fixture, starts real hosts/workers and runs
// several Git/durable-file actions. Windows can exceed Vitest's 5s default.
// This bounds the whole case; production request/Git/SQLite deadlines stay intact.
export const integrationTimeout = process.platform === 'win32' ? 30_000 : 15_000;
if (process.platform === 'win32') vi.setConfig({ testTimeout: integrationTimeout });

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-store-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const worker = join(directory, 'store-worker.cjs');
  await build({
    entryPoints: ['src/storage/worker.ts'],
    outfile: worker,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
  });
  await cp(resolve('native/build/Release/crw_guard.node'), join(directory, 'native-guard.node'));
  const processPath = join(directory, 'store-process.cjs');
  await build({
    entryPoints: ['tests/support/processes/store.ts'],
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

export async function overviewFixture() {
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

export async function repositoryFixture(directory: string) {
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

export async function waitForFile(path: string, timeoutMs = 2500) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

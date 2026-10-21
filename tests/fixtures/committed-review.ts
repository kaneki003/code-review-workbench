import { afterEach, vi } from 'vitest';
import { build } from 'esbuild';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReviewManager } from '../../src/application/review-manager';
import { createStoreConnection } from '../../src/connections/shared-store';
import { createLocalRepositoryConnection } from '../../src/connections/local-repository';
import { createCheckoutGit } from '../../src/connections/checkout-git';
import type { StorageDiagnostics } from '../../src/connections/storage-diagnostics';
import type { StoreConnection } from '../../src/application/private-store';
import type { CheckoutEditors } from '../../src/application/checkout-review';
import type { SourceNavigation } from '../../src/application/committed-source';

export const integrationTimeout = process.platform === 'win32' ? 120_000 : 20_000;
export function checkoutEditors(workspace: string): CheckoutEditors {
  return {
    capture: async () => ({
      protocol: 1,
      workspace,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    }),
    assertSaved() {},
    restore: async () => {},
  };
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function draftTarget(manager: ReviewManager): Promise<SourceNavigation> {
  const result = await manager.inspectPullRequestSource('3001', 20);
  if (result.status !== 'ready') throw new Error(result.detail);
  const file = result.source.files.find((file) => file.path === 'worker.ts')!;
  const content = await manager.readCommittedFile(result.source.id, file.id, 'new');
  if (content.status !== 'available') throw new Error(content.detail);
  return {
    anchor: {
      ...content.anchor,
      range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    },
    control: 'diff',
    focus: 'editor',
    column: 2,
  };
}

export async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-source-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const location = join(directory, 'repository');
  const home = join(directory, 'home');
  await mkdir(location);
  await mkdir(home, { mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', location, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(join(location, 'worker.ts'), 'export const count = 1;\n');
  await writeFile(join(location, 'delete.py'), 'print("old")\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(location, 'worker.ts'), 'export const count = 2;\n// committed\n');
  git('rm', 'delete.py');
  await writeFile(join(location, 'new.py'), 'print("new")\n');
  git('add', '.');
  git('commit', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const remote = join(directory, 'remote.git');
  let transportRequests = 0;
  git('clone', '--bare', location, remote);
  const remoteGit = (...args: string[]) =>
    execFileSync('git', ['--git-dir', remote, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  remoteGit('update-ref', 'refs/heads/main', base);
  remoteGit('update-ref', 'refs/pull/20/head', head);
  remoteGit('update-server-info');
  const server = createServer(async (request, response) => {
    transportRequests += 1;
    try {
      const path = new URL(request.url!, 'http://fixture').pathname;
      if (!/^\/(?:info\/refs|HEAD|objects\/[a-f0-9/]+)$/.test(path))
        throw new Error('Not a Git object');
      response.end(await readFile(join(remote, path)));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address() as { port: number };
  git(
    'config',
    `url.http://127.0.0.1:${address.port}/.insteadOf`,
    'https://github.com/acme/service.git',
  );
  git('remote', 'add', 'origin', 'https://github.com/acme/service.git');
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
  const actor = { host: 'github.com' as const, userId: '1001', login: 'reviewer' };
  const pullRequest = {
    id: '9001',
    number: 20,
    title: 'Committed inspection',
    body: '',
    state: 'open' as const,
    draft: false,
    url: 'https://github.com/acme/service/pull/20',
    author: null,
    base: { repository: { id: '3001', fullName: 'acme/service' }, ref: 'main', oid: base },
    head: { repository: { id: '4001', fullName: 'fork/service' }, ref: 'feature', oid: head },
  };
  function manager(
    diagnostics?: StorageDiagnostics,
    wrap: (store: StoreConnection) => StoreConnection = (store) => store,
    account = actor,
    editors?: CheckoutEditors,
    repositoryLocation = location,
  ) {
    const store = wrap(
      createStoreConnection(
        worker,
        {
          osHome: home,
          candidateRoot: join(home, 'data'),
          windowId: 'source-window',
          location: repositoryLocation,
          actor: account,
        },
        diagnostics,
      ),
    );
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
        folders: [{ scheme: 'file', path: repositoryLocation }],
      }),
      git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: '' }),
      sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: '' }),
      native: async () => ({ id: 'guard', label: 'Guard', status: 'passed', detail: '' }),
      store,
      checkout: createCheckoutGit({ repository: repositoryLocation, windowId: 'source-window' }),
      documents: {
        save: async () => {
          if (!editors) return true;
          await editors.capture();
          editors.assertSaved();
          return true;
        },
      },
      ...(editors ? { editors } : {}),
      account,
      repository: createLocalRepositoryConnection(),
      confirmLocalRepository: async () => true,
      github: {
        resolvePullRequest: async () => ({
          status: 'ready',
          account,
          pullRequest,
          repositories: [
            {
              identity: pullRequest.base.repository,
              remote: { owner: 'acme', repository: 'service', transport: 'https' },
            },
          ],
        }),
        sessionChanged() {},
      },
    });
  }
  async function publishHead() {
    git('add', '.');
    git('commit', '-m', 'later head');
    pullRequest.head.oid = git('rev-parse', 'HEAD');
    remoteGit('fetch', location, '+HEAD:refs/pull/20/head');
    remoteGit('update-server-info');
  }
  async function interruptedInspector(
    checkoutSourceId?: string,
    lifecycleFault?: string,
    stage?: 'exit',
    faultMode: StorageDiagnostics['mode'] = 'error',
  ) {
    const script = join(directory, 'source-process.cjs');
    await build({
      entryPoints: ['tests/fixtures/source-process.ts'],
      outfile: script,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
    });
    const child = fork(
      script,
      [
        worker,
        JSON.stringify({
          osHome: home,
          candidateRoot: join(home, 'data'),
          location,
          windowId: 'crashed-source-host',
          actor,
        }),
        JSON.stringify(pullRequest),
        ...(checkoutSourceId ? [checkoutSourceId] : []),
        ...(lifecycleFault ? [lifecycleFault, stage ?? 'enter', faultMode] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    });
    const [result] = await once(child, 'message');
    return { child, result };
  }
  return {
    directory,
    location,
    git,
    remoteGit,
    base,
    head,
    pullRequest,
    manager,
    publishHead,
    interruptedInspector,
    transportRequests: () => transportRequests,
  };
}

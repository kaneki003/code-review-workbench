import { afterEach, expect, test } from 'vitest';
import { build } from 'esbuild';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReviewManager } from '../src/application/review-manager';
import { createStoreConnection } from '../src/connections/shared-store';
import { createLocalRepositoryConnection } from '../src/connections/local-repository';
import type { StorageDiagnostics } from '../src/connections/storage-diagnostics';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
  function manager(diagnostics?: StorageDiagnostics) {
    const store = createStoreConnection(
      worker,
      {
        osHome: home,
        candidateRoot: join(home, 'data'),
        windowId: 'source-window',
        location,
        actor,
      },
      diagnostics,
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
        folders: [{ scheme: 'file', path: location }],
      }),
      git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: '' }),
      sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: '' }),
      native: async () => ({ id: 'guard', label: 'Guard', status: 'passed', detail: '' }),
      store,
      account: actor,
      repository: createLocalRepositoryConnection(),
      confirmLocalRepository: async () => true,
      github: {
        resolvePullRequest: async () => ({
          status: 'ready',
          account: actor,
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
  async function interruptedInspector() {
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

test('public source actions inspect committed mixed-language changes without adopting working edits', async () => {
  const context = await fixture();
  const manager = context.manager();
  const overview = await manager.openPullRequestOverview(context.pullRequest.url);
  expect(overview, JSON.stringify(overview)).toMatchObject({ status: 'ready' });
  await writeFile(join(context.location, 'worker.ts'), '// staged local code\n');
  context.git('add', 'worker.ts');
  await writeFile(join(context.location, 'worker.ts'), '// unstaged local code\n');
  const before = context.git('status', '--porcelain=v1');
  const result = await manager.inspectPullRequestSource('3001', 20);
  expect(result, JSON.stringify(result)).toMatchObject({
    status: 'ready',
    source: {
      head: context.head,
      baseTip: context.base,
      mergeBase: context.base,
      method: 'merge-base-to-head',
      completeness: 'complete',
    },
  });
  if (result.status !== 'ready') throw new Error(result.detail);
  expect(result.source.files.map((file) => [file.path, file.status])).toEqual([
    ['delete.py', 'D'],
    ['new.py', 'A'],
    ['worker.ts', 'M'],
  ]);
  const file = result.source.files.find((file) => file.path === 'worker.ts')!;
  const source = await manager.readCommittedFile(result.source.id, file.id, 'new');
  expect(source).toMatchObject({
    status: 'available',
    text: 'export const count = 2;\n// committed\n',
  });
  expect(context.git('status', '--porcelain=v1')).toBe(before);
  expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
  expect(await manager.readReviewedMarks(result.source.id)).toEqual([]);
  await manager.releasePrivateStore();
}, 15000);

test('a new owner reconciles an interrupted fetch from actual refs without repeating Git transport', async () => {
  const context = await fixture();
  const { child, result } = await context.interruptedInspector();
  expect(result).toMatchObject({ status: 'unavailable' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const manager = context.manager();
  let recovered = await manager.recoverPrivateStore();
  for (let attempt = 0; recovered.view.status === 'recovery' && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    recovered = await manager.recoverPrivateStore();
  }
  expect(recovered, JSON.stringify(recovered)).toMatchObject({
    view: { status: 'closed' },
    operation: { phase: 'observed' },
  });
  const requests = context.transportRequests();
  await manager.openPrivateStore();
  await expect(manager.readCommittedSource()).resolves.toMatchObject({ status: 'unavailable' });
  expect(context.transportRequests()).toBe(requests);
  await manager.releasePrivateStore();
}, 15000);

test('a moved remote PR head cannot publish a mixed comparison even when old objects exist locally', async () => {
  const context = await fixture();
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  context.remoteGit('update-ref', 'refs/pull/20/head', context.base);
  context.remoteGit('update-server-info');
  const result = await manager.inspectPullRequestSource('3001', 20);
  expect(result).toMatchObject({
    status: 'unavailable',
    detail: expect.stringMatching(/metadata|match|moved/i),
  });
  await expect(manager.readCommittedSource()).resolves.toMatchObject({ status: 'unavailable' });
  expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
  await manager.releasePrivateStore();
}, 15000);

test('explicit Reviewed marks and original navigation survive restart and clear only when the file comparison changes', async () => {
  const context = await fixture();
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  const first = await manager.inspectPullRequestSource('3001', 20);
  if (first.status !== 'ready') throw new Error(first.detail);
  const file = first.source.files.find((file) => file.path === 'worker.ts')!;
  const content = await manager.readCommittedFile(first.source.id, file.id, 'new');
  if (content.status !== 'available') throw new Error(content.detail);
  const navigation = {
    anchor: {
      ...content.anchor,
      range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    },
    control: 'diff' as const,
    focus: 'editor' as const,
    column: 2,
  };
  await manager.saveSourceNavigation(navigation);
  await expect(manager.setFileReviewed(first.source.id, file.id, true)).resolves.toEqual([file.id]);
  await manager.releasePrivateStore();
  const restarted = context.manager();
  await restarted.openPrivateStore();
  await expect(restarted.readSourceNavigation()).resolves.toEqual(navigation);
  await expect(restarted.readReviewedMarks(first.source.id)).resolves.toEqual([file.id]);
  const second = await restarted.inspectPullRequestSource('3001', 20);
  if (second.status !== 'ready') throw new Error(second.detail);
  await expect(restarted.readReviewedMarks(second.source.id)).resolves.toEqual([file.id]);
  // A base-only change changes the comparison without changing the PR head.
  context.pullRequest.base.oid = context.head;
  context.remoteGit('update-ref', 'refs/heads/main', context.head);
  context.remoteGit('update-server-info');
  await restarted.openPullRequestOverview(context.pullRequest.url);
  const third = await restarted.inspectPullRequestSource('3001', 20);
  if (third.status !== 'ready') throw new Error(third.detail);
  expect(third.source.files).toEqual([]);
  await expect(restarted.readReviewedMarks(third.source.id)).resolves.toEqual([]);
  // Reintroducing the old diff must not resurrect a cleared human mark.
  context.pullRequest.base.oid = context.base;
  context.remoteGit('update-ref', 'refs/heads/main', context.base);
  context.remoteGit('update-server-info');
  await restarted.openPullRequestOverview(context.pullRequest.url);
  const fourth = await restarted.inspectPullRequestSource('3001', 20);
  if (fourth.status !== 'ready') throw new Error(fourth.detail);
  await expect(restarted.readReviewedMarks(fourth.source.id)).resolves.toEqual([]);
  await expect(restarted.readSourceNavigation()).resolves.toEqual(navigation);
  await expect(
    restarted.saveSourceNavigation({
      ...navigation,
      anchor: {
        ...navigation.anchor,
        range: { startLine: 900, startCharacter: 0, endLine: 900, endCharacter: 0 },
      },
    }),
  ).rejects.toThrow(/range/);
  await restarted.releasePrivateStore();
}, 20000);

test('the complete local Git comparison exposes over one page of files and explicit non-text limits', async () => {
  const context = await fixture();
  await mkdir(join(context.location, 'many'));
  await Promise.all(
    Array.from({ length: 1101 }, (_, index) =>
      writeFile(join(context.location, 'many', `${index}.rs`), `fn item_${index}() {}\n`),
    ),
  );
  await writeFile(join(context.location, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(
    join(context.location, 'asset.lfs'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9999\n',
  );
  await writeFile(join(context.location, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await context.publishHead();
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  const result = await manager.inspectPullRequestSource('3001', 20);
  if (result.status !== 'ready') throw new Error(result.detail);
  expect(result.source.completeness).toBe('complete');
  expect(result.source.files).toHaveLength(1107);
  for (const [path, status] of [
    ['image.bin', 'binary'],
    ['asset.lfs', 'lfs'],
    ['large.txt', 'unavailable'],
    ['delete.py', 'absent'],
  ] as const) {
    const file = result.source.files.find((file) => file.path === path)!;
    await expect(
      manager.readCommittedFile(result.source.id, file.id, 'new'),
    ).resolves.toMatchObject({ status });
  }
  await manager.releasePrivateStore();
}, 20000);

test('interrupted source publication reconciles pinned source without another fetch', async () => {
  const context = await fixture();
  const manager = context.manager({ boundary: 'source-published.record.after', mode: 'error' });
  await manager.openPullRequestOverview(context.pullRequest.url);
  const failed = await manager.inspectPullRequestSource('3001', 20);
  expect(failed).toMatchObject({ status: 'unavailable', sourceId: expect.any(String) });
  if (failed.status !== 'unavailable' || !failed.sourceId)
    throw new Error('Missing source recovery identity');
  await expect(manager.readCommittedSource()).resolves.toMatchObject({ status: 'unavailable' });
  // Destroy the remote ref. Reconciliation must use the already fetched facts.
  context.remoteGit('update-ref', '-d', 'refs/pull/20/head');
  context.remoteGit('update-server-info');
  await expect(manager.publishCommittedSource(failed.sourceId)).resolves.toMatchObject({
    status: 'ready',
    source: { id: failed.sourceId, head: context.head, baseTip: context.base },
  });
  await manager.releasePrivateStore();
}, 15000);

test('old source stays readable after a force-push and absent objects or ranges never select working code', async () => {
  const context = await fixture();
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  const first = await manager.inspectPullRequestSource('3001', 20);
  if (first.status !== 'ready') throw new Error(first.detail);
  const file = first.source.files.find((file) => file.path === 'worker.ts')!;
  context.git('checkout', '--detach', context.base);
  await writeFile(join(context.location, 'worker.ts'), 'export const count = 99;\n');
  context.git('add', '.');
  context.git('commit', '-m', 'force pushed source');
  context.pullRequest.head.oid = context.git('rev-parse', 'HEAD');
  context.remoteGit('fetch', context.location, '+HEAD:refs/pull/20/head');
  context.remoteGit('update-server-info');
  await manager.openPullRequestOverview(context.pullRequest.url);
  const next = await manager.inspectPullRequestSource('3001', 20);
  expect(next).toMatchObject({ status: 'ready', source: { head: context.pullRequest.head.oid } });
  await expect(manager.readCommittedFile(first.source.id, file.id, 'new')).resolves.toMatchObject({
    status: 'available',
    text: 'export const count = 2;\n// committed\n',
  });
  // Saved source refs retain the old head through normal pruning.
  context.git('reflog', 'expire', '--expire=now', '--all');
  context.git('gc', '--prune=now');
  await expect(manager.readCommittedFile(first.source.id, file.id, 'new')).resolves.toMatchObject({
    status: 'available',
  });
  await expect(manager.setFileReviewed(first.source.id, file.id, true)).rejects.toThrow(
    /older comparison/,
  );
  await manager.releasePrivateStore();
}, 15000);

test('source fetch obtains missing committed objects through the base repository PR ref', async () => {
  const context = await fixture();
  context.git('checkout', '--detach', context.base);
  context.git('update-ref', 'refs/heads/main', context.base);
  await rm(
    join(context.location, '.git', 'objects', context.head.slice(0, 2), context.head.slice(2)),
  );
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  const result = await manager.inspectPullRequestSource('3001', 20);
  expect(result, JSON.stringify(result)).toMatchObject({
    status: 'ready',
    source: { head: context.head, completeness: 'complete' },
  });
  expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
  await manager.releasePrivateStore();
}, 15000);

test('shallow history and multiple merge bases produce explicit comparison limitations', async () => {
  const context = await fixture();
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  await writeFile(join(context.location, '.git', 'shallow'), `${context.base}\n`);
  const shallow = await manager.inspectPullRequestSource('3001', 20);
  expect(shallow).toMatchObject({
    status: 'ready',
    source: {
      completeness: 'unavailable',
      files: [],
      limitations: [expect.stringMatching(/shallow/)],
    },
  });
  await rm(join(context.location, '.git', 'shallow'));
  const tree = context.git('rev-parse', `${context.base}^{tree}`);
  const left = context.git('commit-tree', tree, '-p', context.base, '-m', 'left');
  const right = context.git('commit-tree', tree, '-p', context.base, '-m', 'right');
  const base = context.git('commit-tree', tree, '-p', left, '-p', right, '-m', 'base merge');
  const head = context.git('commit-tree', tree, '-p', right, '-p', left, '-m', 'head merge');
  context.pullRequest.base.oid = base;
  context.pullRequest.head.oid = head;
  context.remoteGit(
    'fetch',
    context.location,
    `+${base}:refs/heads/main`,
    `+${head}:refs/pull/20/head`,
  );
  context.remoteGit('update-server-info');
  await manager.openPullRequestOverview(context.pullRequest.url);
  const multiple = await manager.inspectPullRequestSource('3001', 20);
  expect(multiple).toMatchObject({
    status: 'ready',
    source: {
      completeness: 'unavailable',
      mergeBase: null,
      files: [],
      limitations: [expect.stringMatching(/Multiple merge bases/)],
    },
  });
  await manager.releasePrivateStore();
}, 15000);

test('rename identities keep both paths, and missing blobs never fall back to a current file', async () => {
  const context = await fixture();
  // Move the original path without changing its committed bytes.
  context.git('checkout', '--detach', context.base);
  context.git('mv', 'worker.ts', 'renamed ) # worker.ts');
  await context.publishHead();
  const manager = context.manager();
  await manager.openPullRequestOverview(context.pullRequest.url);
  const result = await manager.inspectPullRequestSource('3001', 20);
  if (result.status !== 'ready') throw new Error(result.detail);
  expect(result.source.files).toHaveLength(1);
  const file = result.source.files[0]!;
  expect(file).toMatchObject({
    status: 'R',
    old: { path: 'worker.ts' },
    new: { path: 'renamed ) # worker.ts' },
  });
  await expect(manager.readCommittedFile(result.source.id, file.id, 'old')).resolves.toMatchObject({
    status: 'available',
    text: 'export const count = 1;\n',
  });
  await rm(
    join(context.location, '.git', 'objects', file.old!.blob.slice(0, 2), file.old!.blob.slice(2)),
  );
  await expect(manager.readCommittedFile(result.source.id, file.id, 'old')).resolves.toMatchObject({
    status: 'unavailable',
  });
  await manager.releasePrivateStore();
}, 15000);

import { expect, test } from 'vitest';
import { once } from 'node:events';
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';

import { join } from 'node:path';

import { fixture, integrationTimeout } from '../support/review/committed-review';

test(
  'public source actions inspect committed mixed-language changes without adopting working edits',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'a new owner reconciles an interrupted fetch from actual refs without repeating Git transport',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'a moved remote PR head cannot publish a mixed comparison even when old objects exist locally',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'explicit Reviewed marks and original navigation survive restart and clear only when the file comparison changes',
  async () => {
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
    await expect(manager.setFileReviewed(first.source.id, file.id, true)).resolves.toEqual([
      file.id,
    ]);
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
  },
  integrationTimeout,
);

test(
  'the complete local Git comparison exposes over one page of files and explicit non-text limits',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'interrupted source publication reconciles pinned source without another fetch',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'old source stays readable after a force-push and absent objects or ranges never select working code',
  async () => {
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
    await expect(manager.readCommittedFile(first.source.id, file.id, 'new')).resolves.toMatchObject(
      {
        status: 'available',
        text: 'export const count = 2;\n// committed\n',
      },
    );
    // Saved source refs retain the old head through normal pruning.
    context.git('reflog', 'expire', '--expire=now', '--all');
    context.git('gc', '--prune=now');
    await expect(manager.readCommittedFile(first.source.id, file.id, 'new')).resolves.toMatchObject(
      {
        status: 'available',
      },
    );
    await expect(manager.setFileReviewed(first.source.id, file.id, true)).rejects.toThrow(
      /older comparison/,
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'source fetch obtains missing committed objects through the base repository PR ref',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'shallow history and multiple merge bases produce explicit comparison limitations',
  async () => {
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
  },
  integrationTimeout,
);

test(
  'rename identities keep both paths, and missing blobs never fall back to a current file',
  async () => {
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
    await expect(
      manager.readCommittedFile(result.source.id, file.id, 'old'),
    ).resolves.toMatchObject({
      status: 'available',
      text: 'export const count = 1;\n',
    });
    await rm(
      join(
        context.location,
        '.git',
        'objects',
        file.old!.blob.slice(0, 2),
        file.old!.blob.slice(2),
      ),
    );
    await expect(
      manager.readCommittedFile(result.source.id, file.id, 'old'),
    ).resolves.toMatchObject({
      status: 'unavailable',
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'an unchanged PR retains its explicit Reviewed marks after inspecting another PR',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const first = await manager.inspectPullRequestSource('3001', 20);
    if (first.status !== 'ready') throw new Error(first.detail);
    const file = first.source.files[0]!;
    await manager.setFileReviewed(first.source.id, file.id, true);
    context.pullRequest.number = 21;
    context.pullRequest.url = 'https://github.com/acme/service/pull/21';
    context.remoteGit('update-ref', 'refs/pull/21/head', context.head);
    context.remoteGit('update-server-info');
    await manager.openPullRequestOverview(context.pullRequest.url);
    const other = await manager.inspectPullRequestSource('3001', 21);
    if (other.status !== 'ready') throw new Error(other.detail);
    await expect(manager.readReviewedMarks(other.source.id)).resolves.toEqual([]);
    context.pullRequest.number = 20;
    context.pullRequest.url = 'https://github.com/acme/service/pull/20';
    await manager.openPullRequestOverview(context.pullRequest.url);
    const again = await manager.inspectPullRequestSource('3001', 20);
    if (again.status !== 'ready') throw new Error(again.detail);
    await expect(manager.readReviewedMarks(again.source.id)).resolves.toEqual([file.id]);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'account fencing prevents an undispatched fetch and suppresses delayed committed content',
  async () => {
    const context = await fixture();
    let pauseAction = 'prepareSourceFetch';
    let release!: () => void;
    let reached!: () => void;
    let paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = context.manager(undefined, (store) => ({
      dispose: () => store.dispose(),
      async request(request) {
        const reply = await store.request(request);
        if (request.action === pauseAction) {
          reached();
          await gate;
        }
        return reply;
      },
    }));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const loading = manager.inspectPullRequestSource('3001', 20);
    await paused;
    manager.fencePullRequestOverview();
    release();
    await expect(loading).resolves.toMatchObject({ status: 'unavailable' });
    expect(context.transportRequests()).toBe(0);
    await manager.recoverPrivateStore();
    pauseAction = '';
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    pauseAction = 'readCommittedFile';
    paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = manager.readCommittedFile(source.source.id, source.source.files[0]!.id, 'old');
    await paused;
    manager.fencePullRequestOverview();
    release();
    await expect(reading).resolves.toMatchObject({ status: 'unavailable' });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'changed submodule commits stay in the complete list despite repository ignore configuration',
  async () => {
    const context = await fixture();
    context.git('update-index', '--add', '--cacheinfo', `160000,${context.base},nested`);
    context.git('commit', '-m', 'base with submodule');
    context.pullRequest.base.oid = context.git('rev-parse', 'HEAD');
    context.git('update-index', '--cacheinfo', `160000,${context.head},nested`);
    context.git('commit', '-m', 'changed submodule');
    context.pullRequest.head.oid = context.git('rev-parse', 'HEAD');
    context.remoteGit(
      'fetch',
      context.location,
      `+${context.pullRequest.base.oid}:refs/heads/main`,
      '+HEAD:refs/pull/20/head',
    );
    context.remoteGit('update-server-info');
    context.git('config', 'diff.ignoreSubmodules', 'all');
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const result = await manager.inspectPullRequestSource('3001', 20);
    if (result.status !== 'ready') throw new Error(result.detail);
    expect(result.source.files.map((file) => file.path)).toEqual(['nested']);
    await expect(
      manager.readCommittedFile(result.source.id, result.source.files[0]!.id, 'new'),
    ).resolves.toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/Submodule/) });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

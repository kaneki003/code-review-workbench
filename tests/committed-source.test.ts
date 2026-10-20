import { expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { mkdir, rm, writeFile, readFile, rename, link, stat, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  draftEditRequests,
  draftControlRequest,
  draftTransportBytes,
} from '../src/shared/draft-writer';

import { fixture, draftTarget, integrationTimeout } from './fixtures/committed-review';

test(
  'host-owned typing saves after idle and an older acknowledgment cannot save newer pending input',
  async () => {
    const context = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const manager = context.manager(undefined, (store) => ({
      async request(request) {
        const reply = await store.request(request);
        if (request.action === 'saveDraft' && !held) {
          held = true;
          entered();
          await gate;
        }
        return reply;
      },
      dispose: () => store.dispose(),
    }));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const writer = await manager.openDraftWriter(draft.id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    manager.editDraftWriter(writer.writerId, 0, 'first 🐈\nunfinished **');
    expect(manager.readDraftWriter()).toMatchObject({
      body: 'first 🐈\nunfinished **',
      status: 'saving',
      committedRevision: 0,
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: '',
      committedRevision: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    manager.editDraftWriter(writer.writerId, 1, 'newest input');
    release();
    await manager.flushDraftWriter();
    expect(manager.readDraftWriter()).toMatchObject({
      body: 'newest input',
      status: 'saved',
      editRevision: 2,
      committedRevision: 2,
    });
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: 'newest input',
      committedRevision: 2,
    });
    vi.useRealTimers();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'continuous typing schedules a real committed save by one second without waiting for idle',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const writer = await manager.openDraftWriter(draft.id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const saved = new Promise<void>((resolve) => {
      const unsubscribe = manager.onDraftWriterChange(() => {
        if (manager.readDraftWriter()?.committedRevision === 4) {
          unsubscribe();
          resolve();
        }
      });
    });
    for (let revision = 0; revision < 4; revision += 1) {
      if (revision) await vi.advanceTimersByTimeAsync(250);
      manager.editDraftWriter(writer.writerId, revision, `continuous ${revision + 1}`);
    }
    await vi.advanceTimersByTimeAsync(249);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: '',
      committedRevision: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    await saved;
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: 'continuous 4',
      committedRevision: 4,
    });
    vi.useRealTimers();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'failed Close keeps the original writer input and target until Retry commits it',
  async () => {
    const context = await fixture();
    const manager = context.manager({ boundary: 'saveDraft.commit.before', mode: 'disk-full' });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const target = await draftTarget(manager);
    const draft = await manager.createLocalDraft(target);
    const writer = await manager.openDraftWriter(draft.id);
    manager.editDraftWriter(writer.writerId, 0, 'keep this unsaved input 🐈');
    expect(await manager.closeDraftWriter(writer.writerId)).toBeUndefined();
    expect(manager.readDraftWriter()).toMatchObject({
      id: draft.id,
      target,
      body: 'keep this unsaved input 🐈',
      status: 'failed',
      committedRevision: 0,
    });
    expect(await manager.retryDraftWriter(writer.writerId)).toBe(true);
    expect(await manager.closeDraftWriter(writer.writerId)).toEqual(target);
    expect(manager.readDraftWriter()).toBeUndefined();
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: 'keep this unsaved input 🐈',
      committedRevision: 1,
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'complete view payloads save after disposal and a recreated view fences old-instance edits',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    await manager.openDraftWriter(draft.id);
    const first = manager.attachDraftWriter(randomUUID());
    expect(first.state).toMatchObject({ id: draft.id, body: '', status: 'saved' });
    const body = '🧪'.repeat(256 * 1024);
    const incomplete = draftEditRequests(first, body);
    expect((await manager.handleDraftWriterMessage(incomplete.at(-1)!)).accepted).toBe(false);
    expect(manager.readDraftWriter()).toMatchObject({ body: '', editRevision: 0 });
    const messages = draftEditRequests(first, body);
    for (const message of messages) {
      expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(
        draftTransportBytes,
      );
      expect((await manager.handleDraftWriterMessage(message)).accepted).toBe(true);
    }
    expect((await manager.handleDraftWriterMessage(messages.at(-1)!)).duplicate).toBe(true);
    expect(manager.readDraftWriter()).toMatchObject({ body, editRevision: 1, status: 'saving' });
    manager.detachDraftWriter(first.instanceId);
    const next = manager.attachDraftWriter(randomUUID());
    expect(next.state).toMatchObject({ id: draft.id, body, target: draft.target, editRevision: 1 });
    const stale = await manager.handleDraftWriterMessage({
      version: 1,
      type: 'sync',
      instanceId: first.instanceId,
      requestId: randomUUID(),
    });
    expect(stale.accepted).toBe(false);
    const sync = await manager.handleDraftWriterMessage({
      version: 1,
      type: 'sync',
      instanceId: next.instanceId,
      requestId: randomUUID(),
    });
    expect(sync.snapshot).toMatchObject({
      instanceId: next.instanceId,
      reset: true,
      state: { id: draft.id },
    });
    expect(await manager.flushDraftWriter()).toBe(true);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body, committedRevision: 1 });
    const current = manager.snapshotDraftWriter(next.instanceId);
    const retry = draftControlRequest(current, 'retry');
    for (const invalid of [
      { ...retry, version: 2 },
      { ...retry, unexpected: 'field' },
      { ...retry, fence: retry.fence + 1 },
      { ...retry, contentGeneration: 2 },
      { ...retry, reviewId: randomUUID() },
      { ...retry, expectedRowRevision: 999 },
    ]) {
      expect((await manager.handleDraftWriterMessage(invalid)).accepted).toBe(false);
    }
    expect(manager.readDraftWriter()).toMatchObject({
      body,
      editRevision: 1,
      committedRevision: 1,
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'public Enter and Exit commit Active only after checkout and restore the saved editor snapshot',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const original = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { orientation: 0, groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    let restored: unknown;
    const manager = context.manager(undefined, undefined, undefined, {
      capture: async () => original,
      assertSaved() {},
      restore: async (snapshot) => {
        restored = snapshot;
      },
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, JSON.stringify(entered)).toMatchObject({
      status: 'active',
      review: { phase: 'active', sourceId: source.source.id },
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect((await manager.readCheckoutReview())?.phase).toBe('active');
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, JSON.stringify(exited)).toMatchObject({
      status: 'complete',
      review: { phase: 'complete' },
    });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(restored).toEqual(original);
    expect((await manager.readCheckoutReview())?.phase).toBe('complete');
    expect(
      context.git(
        'for-each-ref',
        '--format=%(refname)',
        `refs/code-review-workbench/recovery/${entered.review!.entryId}/original`,
      ),
    ).toBe('');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'manual return to the original checkout requires explicit restoration rather than Continue completing Exit',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    let restores = 0;
    const manager = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {
        restores += 1;
      },
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    context.git('checkout', 'prior-work');
    const before = context.git('reflog', 'show', '--format=%gs', 'HEAD');
    expect(await manager.recoverPullRequestCheckout('continue')).toMatchObject({
      status: 'blocked',
      detail: expect.stringMatching(/original.*Restore/i),
    });
    expect((await manager.readCheckoutReview())?.phase).toBe('active');
    expect(restores).toBe(0);
    expect(await manager.recoverPullRequestCheckout('restore')).toMatchObject({
      status: 'complete',
    });
    expect(restores).toBe(1);
    expect(context.git('reflog', 'show', '--format=%gs', 'HEAD')).toBe(before);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'failed host restoration retains recovery across restart and retries editors without another checkout',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const first = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {
        throw new Error('Host refused layout restoration');
      },
    });
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await first.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    expect(await first.exitPullRequestCheckout()).toMatchObject({
      status: 'recovery',
      detail: 'Host refused layout restoration',
    });
    expect((await first.readCheckoutReview())?.phase).toBe('restoring-editors');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    const reflog = context.git('reflog', 'show', '--format=%gs', 'HEAD');
    await first.dispose();
    let restored: unknown;
    const second = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async (value) => {
        restored = value;
      },
    });
    await second.openPrivateStore();
    expect(await second.recoverPullRequestCheckout('restore')).toMatchObject({
      status: 'complete',
    });
    expect(restored).toEqual(snapshot);
    expect(context.git('reflog', 'show', '--format=%gs', 'HEAD')).toBe(reflog);
    await second.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'cancelled normal host saves refuse Enter before any checkout or recovery ref is created',
  async () => {
    const context = await fixture();
    const manager = context.manager(undefined, undefined, undefined, {
      capture: async () => {
        throw new Error('Save cancelled');
      },
      assertSaved() {},
      restore: async () => {},
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'blocked',
      detail: 'Save cancelled',
    });
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(
      context.git(
        'for-each-ref',
        '--format=%(refname)',
        'refs/code-review-workbench/recovery/',
        'refs/heads/code-review-workbench/',
      ),
    ).toBe('');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  { boundary: 'checkout-active.record.after', mode: 'error' as const },
  { boundary: 'checkout-active.commit.before', mode: 'commit' as const },
  { boundary: 'checkout-active.commit.after', mode: 'crash' as const },
])(
  'interrupted Active publication at $boundary reconciles independent intent and actual checkout',
  async ({ boundary, mode }) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child, result } = await context.interruptedInspector(
      source.source.id,
      boundary,
      undefined,
      mode,
    );
    expect(result.result).toMatchObject({ status: 'recovery' });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const recovered = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    expect((await recovered.inspectPrivateStore()).checkoutPending).toBe(true);
    const resumed = await recovered.recoverPullRequestCheckout('continue');
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'active' });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    const exitedReview = await recovered.exitPullRequestCheckout();
    expect(exitedReview, JSON.stringify(exitedReview)).toMatchObject({ status: 'complete' });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  { boundary: 'checkout-restoring-editors.record.after', mode: 'error' as const, retryExit: false },
  { boundary: 'checkout-complete.record.after', mode: 'error' as const, retryExit: false },
  { boundary: 'checkout-complete.commit.after', mode: 'crash' as const, retryExit: false },
  { boundary: 'checkout-complete.commit.after', mode: 'crash' as const, retryExit: true },
])(
  'interrupted editor-restoration publication at $boundary (retry Exit: $retryExit) finishes without repeating checkout',
  async ({ boundary, mode, retryExit }) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child, result } = await context.interruptedInspector(
      source.source.id,
      boundary,
      'exit',
      mode,
    );
    expect(result.result).toMatchObject({ status: 'recovery' });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const before = context.git('reflog', 'show', '--format=%gs', 'HEAD');
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const recovered = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    if (retryExit) await recovered.openPrivateStore();
    const restored = retryExit
      ? await recovered.exitPullRequestCheckout()
      : await recovered.recoverPullRequestCheckout('restore');
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'complete' });
    expect(context.git('reflog', 'show', '--format=%gs', 'HEAD')).toBe(before);
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(
      context.git('for-each-ref', '--format=%(refname)', 'refs/code-review-workbench/recovery/'),
    ).toBe('');
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'original branch ownership in another worktree blocks Exit and recovers after that owner is released',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const manager = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    const other = join(context.directory, 'other-worktree');
    context.git('worktree', 'add', other, 'prior-work');
    expect(await manager.exitPullRequestCheckout()).toMatchObject({
      status: 'recovery',
      detail: expect.stringMatching(/worktree/),
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect(
      execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(context.base);
    context.git('worktree', 'remove', other);
    const recovered = await manager.recoverPullRequestCheckout('restore');
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ status: 'complete' });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'an unrelated repository receives no checkout startup choice or restoration authority',
  async () => {
    const context = await fixture();
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const first = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await first.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    await first.releasePrivateStore();
    const other = join(context.directory, 'unrelated');
    await mkdir(other);
    execFileSync('git', ['-C', other, 'init'], { stdio: 'pipe' });
    const unrelated = context.manager(
      undefined,
      undefined,
      undefined,
      {
        capture: async () => ({ ...snapshot, workspace: other }),
        assertSaved() {},
        restore: async () => {
          throw new Error('Must not restore unrelated editors');
        },
      },
      other,
    );
    expect((await unrelated.inspectPrivateStore()).checkoutPending).toBeUndefined();
    expect(await unrelated.recoverPullRequestCheckout('restore')).toMatchObject({
      status: 'blocked',
      detail: expect.stringMatching(/local repository/),
    });
    expect(
      execFileSync('git', ['-C', other, 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim(),
    ).toBe('');
    await unrelated.releasePrivateStore();
    const restored = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    expect(await restored.recoverPullRequestCheckout('restore')).toMatchObject({
      status: 'complete',
    });
    await restored.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'entry interruption before checkout restores from facts without dispatching a replacement checkout',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const before = context.git('reflog', 'show', '--format=%gs', 'HEAD');
    const { child } = await context.interruptedInspector(
      source.source.id,
      'checkout.dispatch.before',
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const recovered = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    let restored = await recovered.recoverPullRequestCheckout('restore');
    const settlementDeadline = Date.now() + 5000;
    while (restored.status !== 'complete' && Date.now() < settlementDeadline) {
      expect(restored.detail).toMatch(/recorded Git process or its descendants may still run/);
      expect((await recovered.inspectPrivateStore()).checkoutPending).toBe(true);
      expect(context.git('reflog', 'show', '--format=%gs', 'HEAD')).toBe(before);
      await new Promise((resolve) => setTimeout(resolve, 20));
      restored = await recovered.recoverPullRequestCheckout('restore');
    }
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'complete' });
    expect(context.git('reflog', 'show', '--format=%gs', 'HEAD')).toBe(before);
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'oversized Unicode editor snapshots refuse entry before recovery intent or Git effects',
  async () => {
    const context = await fixture();
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [
        {
          column: 1,
          active: true,
          tabs: [
            {
              kind: 'text' as const,
              uri: 'crw-overview:/large.md',
              content: '字'.repeat(30000),
              active: true,
              pinned: false,
              preview: false,
              views: [],
            },
          ],
        },
      ],
    };
    const manager = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'blocked',
    });
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  { boundary: 'checkout-entering.record.after', mode: 'error' as const },
  { boundary: 'checkout-entering.commit.before', mode: 'commit' as const },
  { boundary: 'checkout-entering.record', mode: 'native' as const },
])(
  'entry intent failure at $boundary preserves original facts and offers restoration',
  async ({ boundary, mode }) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const before = context.git('reflog', 'show', '--format=%gs', 'HEAD');
    const { child } = await context.interruptedInspector(
      source.source.id,
      boundary,
      undefined,
      mode,
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const snapshot = {
      protocol: 1 as const,
      workspace: context.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    };
    const recovered = context.manager(undefined, undefined, undefined, {
      capture: async () => snapshot,
      assertSaved() {},
      restore: async () => {},
    });
    const restored = await recovered.recoverPullRequestCheckout('restore');
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'complete' });
    expect(context.git('reflog', 'show', '--format=%gs', 'HEAD')).toBe(before);
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'guarded clean checkout enters the exact PR on a fresh branch and restores the original commit',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const manager = context.manager();
    expect(await manager.openPullRequestOverview(context.pullRequest.url)).toMatchObject({
      status: 'ready',
    });
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entry = await manager.prepareCleanCheckout(source.source.id);
    expect(entry, JSON.stringify(entry)).toMatchObject({
      operation: { phase: 'prepared' },
    });
    const operationId = entry.operation!.id;
    expect(await manager.executeRepositoryOperation(operationId)).toMatchObject({
      operation: { phase: 'observed', outcome: 'applied' },
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect(context.git('symbolic-ref', 'HEAD')).toBe(
      `refs/heads/code-review-workbench/${operationId}`,
    );
    expect(context.git('status', '--porcelain=v1')).toBe('');
    const restore = await manager.prepareCleanRestore(operationId);
    expect(restore, JSON.stringify(restore)).toMatchObject({
      operation: { phase: 'prepared' },
    });
    expect(await manager.executeRepositoryOperation(restore.operation!.id)).toMatchObject({
      operation: { phase: 'observed', outcome: 'applied' },
    });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(context.git('status', '--porcelain=v1')).toBe('');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'clean checkout refuses a shared HEAD reflog before any switch',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const log = join(context.location, '.git', 'logs', 'HEAD');
    const sentinel = join(context.directory, 'shared-log');
    await rename(log, sentinel);
    await link(sentinel, log);
    const before = await readFile(sentinel, 'utf8');
    expect(await manager.prepareCleanCheckout(source.source.id)).toMatchObject({
      view: { code: 'INVALID_OPERATION' },
    });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(await readFile(sentinel, 'utf8')).toBe(before);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'protected checkout leaves an ignored collision and original branch intact',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.git', 'info', 'exclude'), 'new.py\n');
    await writeFile(join(context.location, 'new.py'), 'ignored local configuration\n');
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entry = await manager.prepareCleanCheckout(source.source.id);
    expect(entry, JSON.stringify(entry)).toHaveProperty('operation.id');
    expect(await manager.executeRepositoryOperation(entry.operation!.id)).toMatchObject({
      operation: { phase: 'observed', outcome: 'not-applied' },
    });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(await readFile(join(context.location, 'new.py'), 'utf8')).toBe(
      'ignored local configuration\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'interrupted checkout reconciles its actual result without repeating the switch',
  async () => {
    const context = await fixture();
    context.git('checkout', '--detach', context.base);
    const initial = context.manager();
    await initial.openPullRequestOverview(context.pullRequest.url);
    const source = await initial.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await initial.dispose();
    const { child, result: interrupted } = await context.interruptedInspector(source.source.id);
    const entry = interrupted.entry;
    expect(entry, JSON.stringify(entry)).toHaveProperty('operation.id');
    expect(interrupted.result).toMatchObject({
      view: { status: 'recovery' },
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = context.manager();
    let receipt = await recovered.recoverPrivateStore();
    for (let attempt = 0; receipt.view.status === 'recovery' && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      receipt = await recovered.recoverPrivateStore();
    }
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      view: { status: 'closed' },
      operation: { phase: 'observed', outcome: 'applied' },
    });
    const log = context.git('reflog', 'show', '--format=%gs', 'HEAD');
    expect(
      log
        .split('\n')
        .filter((line) => line.includes(`to code-review-workbench/${entry.operation!.id}`)),
    ).toHaveLength(1);
    await recovered.openPrivateStore();
    const restore = await recovered.prepareCleanRestore(entry.operation!.id);
    expect(restore, JSON.stringify(restore)).toHaveProperty('operation.id');
    expect(await recovered.executeRepositoryOperation(restore.operation!.id)).toMatchObject({
      operation: { phase: 'observed', outcome: 'applied' },
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(context.git('rev-parse', '--symbolic-full-name', 'HEAD')).toBe('HEAD');
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'split-index state refuses checkout while retaining exact committed-source reading',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    context.git('update-index', '--split-index');
    expect(await manager.prepareCleanCheckout(source.source.id)).toMatchObject({
      view: { code: 'UNSUPPORTED_CHECKOUT' },
    });
    expect(await manager.readCommittedSource(source.source.id)).toMatchObject({ status: 'ready' });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'unfinished work and moved original branches refuse restoration without losing user work',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await writeFile(join(context.location, 'worker.ts'), 'unfinished prior work\n');
    expect(await manager.prepareCleanCheckout(source.source.id)).toMatchObject({
      view: { code: 'DIRTY_CHECKOUT' },
    });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unfinished prior work\n',
    );
    context.git('restore', 'worker.ts');
    const entry = await manager.prepareCleanCheckout(source.source.id);
    expect(await manager.executeRepositoryOperation(entry.operation!.id)).toMatchObject({
      operation: { outcome: 'applied' },
    });
    await writeFile(join(context.location, 'worker.ts'), 'unfinished review edit\n');
    expect(await manager.prepareCleanRestore(entry.operation!.id)).toMatchObject({
      view: { code: 'DIRTY_CHECKOUT' },
    });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unfinished review edit\n',
    );
    context.git('restore', 'worker.ts');
    context.git('update-ref', 'refs/heads/prior-work', context.head);
    expect(await manager.prepareCleanRestore(entry.operation!.id)).toMatchObject({
      view: { code: 'CHECKOUT_INTERFERENCE' },
    });
    expect(context.git('rev-parse', 'prior-work')).toBe(context.head);
    expect(context.git('symbolic-ref', 'HEAD')).toBe(
      `refs/heads/code-review-workbench/${entry.operation!.id}`,
    );
    await writeFile(join(context.location, 'worker.ts'), '// user commit\n');
    context.git('add', 'worker.ts');
    context.git('commit', '-m', 'user work on the review branch');
    const userCommit = context.git('rev-parse', 'HEAD');
    expect(await manager.prepareCleanRestore(entry.operation!.id)).toMatchObject({
      view: { code: 'CHECKOUT_INTERFERENCE' },
    });
    expect(
      context.git('rev-parse', `refs/heads/code-review-workbench/${entry.operation!.id}`),
    ).toBe(userCommit);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'clean checkout refuses changed bytes hidden by Git stat-cache settings',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const path = join(context.location, 'worker.ts');
    context.git('config', 'core.trustctime', 'false');
    context.git('config', 'core.checkstat', 'minimal');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(path, old, old);
    context.git('update-index', '--refresh');
    const cached = await stat(path);
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await writeFile(path, 'export const count = 9;\n');
    await utimes(path, cached.atime, cached.mtime);
    expect(context.git('status', '--porcelain=v1')).toBe('');
    expect(await manager.prepareCleanCheckout(source.source.id)).toMatchObject({
      view: { code: 'DIRTY_CHECKOUT' },
    });
    expect(await readFile(path, 'utf8')).toBe('export const count = 9;\n');
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'entry pins an otherwise unreachable detached original commit until exact restoration',
  async () => {
    const context = await fixture();
    context.git('checkout', '--detach', context.base);
    await writeFile(join(context.location, 'prior.txt'), 'committed prior work\n');
    context.git('add', 'prior.txt');
    context.git('commit', '-m', 'detached user work');
    const original = context.git('rev-parse', 'HEAD');
    const manager = context.manager();
    const overview = await manager.openPullRequestOverview(context.pullRequest.url);
    expect(overview, JSON.stringify(overview)).toMatchObject({ status: 'ready' });
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entry = await manager.prepareCleanCheckout(source.source.id);
    expect(entry, JSON.stringify(entry)).toHaveProperty('operation.id');
    expect(
      context.git(
        'rev-parse',
        `refs/code-review-workbench/recovery/${entry.operation!.id}/original`,
      ),
    ).toBe(original);
    expect(await manager.executeRepositoryOperation(entry.operation!.id)).toMatchObject({
      operation: { outcome: 'applied' },
    });
    context.git('reflog', 'expire', '--expire=now', '--all');
    context.git('gc', '--prune=now');
    expect(context.git('cat-file', '-t', original)).toBe('commit');
    const restore = await manager.prepareCleanRestore(entry.operation!.id);
    expect(await manager.executeRepositoryOperation(restore.operation!.id)).toMatchObject({
      operation: { outcome: 'applied' },
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(original);
    expect(await readFile(join(context.location, 'prior.txt'), 'utf8')).toBe(
      'committed prior work\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'creating original-commit protection works when the repository has no reflog directory',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    context.git('config', 'core.logAllRefUpdates', 'false');
    await rm(join(context.location, '.git', 'logs'), { recursive: true });
    const entry = await manager.prepareCleanCheckout(source.source.id);
    expect(entry, JSON.stringify(entry)).toHaveProperty('operation.id');
    expect(await manager.executeRepositoryOperation(entry.operation!.id)).toMatchObject({
      operation: { outcome: 'applied' },
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

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

test(
  'acknowledged private feedback reopens at its original committed target after restart',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const target = await draftTarget(manager);
    const before = context.git('status', '--porcelain=v1');
    const transportRequests = context.transportRequests();
    const draft = await manager.createLocalDraft(target);
    const receipt = await manager.saveLocalDraft({
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: draft.rowRevision,
      expectedCommittedRevision: draft.committedRevision,
      editRevision: 3,
      body: 'Why is this safe? 🐈\n\n```ts\nunfinished **Markdown',
    });
    expect(receipt).toMatchObject({
      draftId: draft.id,
      editRevision: 3,
      committedRevision: 3,
      rowRevision: 2,
      deletionRevision: 0,
    });
    await manager.releasePrivateStore();
    const restarted = context.manager();
    await restarted.openPrivateStore();
    const recovered = await restarted.readLocalDraft(draft.id);
    expect(recovered).toEqual({
      ...draft,
      body: 'Why is this safe? 🐈\n\n```ts\nunfinished **Markdown',
      editRevision: 3,
      committedRevision: 3,
      rowRevision: 2,
    });
    expect(await restarted.listLocalDrafts(target.anchor.sourceId)).toEqual([recovered]);
    expect(await restarted.readReviewedMarks(target.anchor.sourceId)).toEqual([]);
    expect(context.git('status', '--porcelain=v1')).toBe(before);
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect(context.transportRequests()).toBe(transportRequests);
    await restarted.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'duplicate draft saves have one durable result and conflicting or reordered edits cannot replace newer text',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const first = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'first',
    };
    const receipt = await manager.saveLocalDraft(first);
    expect(await manager.saveLocalDraft(first)).toEqual(receipt);
    const second = {
      ...first,
      requestId: randomUUID(),
      expectedRowRevision: 2,
      expectedCommittedRevision: 1,
      editRevision: 5,
      body: 'newest input',
    };
    await manager.saveLocalDraft(second);
    expect(await manager.saveLocalDraft(first)).toEqual(receipt);
    await expect(manager.saveLocalDraft({ ...first, body: 'collision' })).rejects.toMatchObject({
      code: 'REQUEST_COLLISION',
    });
    await expect(
      manager.saveLocalDraft({ ...first, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
    for (const changed of [{ reviewId: randomUUID() }, { contentGeneration: 2 }]) {
      await expect(
        manager.saveLocalDraft({
          ...second,
          ...changed,
          requestId: randomUUID(),
          expectedRowRevision: 3,
          expectedCommittedRevision: 5,
          editRevision: 6,
        }),
      ).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
    }
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: 'newest input',
      committedRevision: 5,
      rowRevision: 3,
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'discard durably deletes one draft and delayed or duplicate saves cannot revive its identity',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const target = await draftTarget(manager);
    const draft = await manager.createLocalDraft(target);
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'private feedback to discard',
    };
    const saved = await manager.saveLocalDraft(edit);
    const discard = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 2,
      expectedCommittedRevision: 1,
    };
    const discarded = manager.discardLocalDraft(discard);
    const delayed = manager.saveLocalDraft({
      ...edit,
      requestId: randomUUID(),
      expectedRowRevision: 2,
      expectedCommittedRevision: 1,
      editRevision: 2,
      body: 'delayed save',
    });
    const rejected = expect(delayed).rejects.toMatchObject({ code: 'DRAFT_DELETED' });
    expect(await discarded).toMatchObject({
      draftId: draft.id,
      rowRevision: 3,
      deletionRevision: 3,
    });
    await rejected;
    expect(await manager.discardLocalDraft(discard)).toMatchObject({ deletionRevision: 3 });
    expect(await manager.saveLocalDraft(edit)).toEqual(saved);
    await manager.releasePrivateStore();
    const restarted = context.manager();
    await restarted.openPrivateStore();
    expect(await restarted.readLocalDraft(draft.id)).toMatchObject({
      body: '',
      deletionRevision: 3,
    });
    expect(await restarted.listLocalDrafts(target.anchor.sourceId)).toEqual([]);
    const fresh = await restarted.createLocalDraft(target);
    expect(fresh.id).not.toBe(draft.id);
    expect(fresh).toMatchObject({
      reviewId: draft.reviewId,
      target,
      body: '',
      editRevision: 0,
      deletionRevision: 0,
    });
    await restarted.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['saveDraft', 'discardDraft'] as const)(
  '%s rolls back its text and receipt together on a real SQLite commit failure, then permits Retry',
  async (action) => {
    const context = await fixture();
    const manager = context.manager({ boundary: `${action}.commit.before`, mode: 'commit' });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'retain this private input',
    };
    if (action === 'saveDraft') {
      await expect(manager.saveLocalDraft(edit)).rejects.toMatchObject({
        code: 'DRAFT_WRITE_FAILED',
      });
      expect(await manager.readLocalDraft(draft.id)).toEqual(draft);
      expect(await manager.saveLocalDraft(edit)).toMatchObject({
        committedRevision: 1,
        rowRevision: 2,
      });
      expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: edit.body });
    } else {
      await manager.saveLocalDraft(edit);
      const discard = {
        ...edit,
        requestId: randomUUID(),
        expectedRowRevision: 2,
        expectedCommittedRevision: 1,
      };
      await expect(manager.discardLocalDraft(discard)).rejects.toMatchObject({
        code: 'DRAFT_WRITE_FAILED',
      });
      expect(await manager.readLocalDraft(draft.id)).toMatchObject({
        body: edit.body,
        deletionRevision: 0,
        rowRevision: 2,
      });
      expect(await manager.discardLocalDraft(discard)).toMatchObject({ deletionRevision: 3 });
    }
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['read-only', 'disk-full'] as const)(
  'a real SQLite %s error keeps the acknowledged draft intact and permits a later retry',
  async (mode) => {
    const context = await fixture();
    const manager = context.manager({ boundary: 'saveDraft.commit.before', mode });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'keep this input visible',
    };
    await expect(manager.saveLocalDraft(edit)).rejects.toMatchObject({
      code: 'DRAFT_WRITE_FAILED',
    });
    expect(await manager.readLocalDraft(draft.id)).toEqual(draft);
    expect(await manager.saveLocalDraft(edit)).toMatchObject({
      rowRevision: 2,
      committedRevision: 1,
    });
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: edit.body });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'drafts preserve Unicode exactly at the UTF-8 ceiling and reject oversized or malformed replacements',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: '\ufeffUnicode 🐈\n\0unfinished **',
    };
    await manager.saveLocalDraft(edit);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: edit.body });
    const limit = '🧪'.repeat(256 * 1024);
    const next = {
      ...edit,
      requestId: randomUUID(),
      expectedRowRevision: 2,
      expectedCommittedRevision: 1,
      editRevision: 2,
      body: limit,
    };
    for (const body of [limit + 'a', 'a'.repeat(1024 * 1024 + 1), '\ud800']) {
      await expect(
        manager.saveLocalDraft({ ...next, body, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'INVALID_DRAFT' });
      expect(await manager.readLocalDraft(draft.id)).toMatchObject({
        body: edit.body,
        committedRevision: 1,
      });
    }
    await manager.saveLocalDraft(next);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: limit,
      committedRevision: 2,
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a queued draft save owns the input captured when the public action was requested',
  async () => {
    const context = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = context.manager(undefined, (store) => ({
      async request(request) {
        if (request.action === 'saveDraft') {
          entered();
          await gate;
        }
        return store.request(request);
      },
      dispose: () => store.dispose(),
    }));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'captured input',
    };
    const saving = manager.saveLocalDraft(edit);
    await waiting;
    edit.body = 'input changed while waiting';
    release();
    await saving;
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: 'captured input' });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'an actual competing SQLite writer yields a retryable save without advancing the draft',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const draft = await manager.createLocalDraft(await draftTarget(manager));
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'saved after contention',
    };
    const contender = new DatabaseSync(join(context.directory, 'home', 'data', 'review.sqlite'));
    try {
      contender.exec('BEGIN IMMEDIATE');
      await expect(manager.saveLocalDraft(edit)).rejects.toMatchObject({
        code: 'DRAFT_WRITE_FAILED',
      });
      expect(await manager.readLocalDraft(draft.id)).toEqual(draft);
    } finally {
      if (contender.isTransaction) contender.exec('ROLLBACK');
      contender.close();
    }
    await manager.saveLocalDraft(edit);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: edit.body,
      rowRevision: 2,
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'account changes cannot read or inherit another account draft and old targets survive newer source',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const target = await draftTarget(manager);
    const draft = await manager.createLocalDraft(target);
    const edit = {
      requestId: randomUUID(),
      draftId: draft.id,
      reviewId: draft.reviewId,
      contentGeneration: draft.contentGeneration,
      expectedRowRevision: 1,
      expectedCommittedRevision: 0,
      editRevision: 1,
      body: 'original account feedback',
    };
    await manager.saveLocalDraft(edit);
    manager.fencePullRequestOverview();
    await expect(manager.readLocalDraft(draft.id)).rejects.toThrow(/verify.*account/);
    await expect(manager.saveLocalDraft(edit)).rejects.toThrow(/verify.*account/);
    await manager.releasePrivateStore();
    const other = context.manager(undefined, undefined, {
      host: 'github.com',
      userId: '2002',
      login: 'another-reviewer',
    });
    expect(await other.openPullRequestOverview(context.pullRequest.url)).toMatchObject({
      status: 'ready',
    });
    expect(await other.readLocalDraft(draft.id)).toBeUndefined();
    await expect(other.saveLocalDraft(edit)).rejects.toMatchObject({ code: 'REQUEST_COLLISION' });
    await expect(other.saveLocalDraft({ ...edit, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'DRAFT_UNAVAILABLE',
    });
    const otherDraft = await other.createLocalDraft(await draftTarget(other));
    expect(otherDraft).toMatchObject({ body: '' });
    expect(otherDraft.reviewId).not.toBe(draft.reviewId);
    await other.releasePrivateStore();
    const original = context.manager();
    await original.openPrivateStore();
    expect(await original.readLocalDraft(draft.id)).toMatchObject({ target, body: edit.body });
    await writeFile(
      join(context.location, 'worker.ts'),
      'export const count = 3;\n// newer committed\n',
    );
    await context.publishHead();
    await original.openPullRequestOverview(context.pullRequest.url);
    const newerTarget = await draftTarget(original);
    expect(newerTarget.anchor.sourceId).not.toBe(target.anchor.sourceId);
    const newerDraft = await original.createLocalDraft(newerTarget);
    expect(newerDraft).toMatchObject({ reviewId: draft.reviewId, target: newerTarget, body: '' });
    expect(await original.readLocalDraft(draft.id)).toMatchObject({ target, body: edit.body });
    expect(await original.listLocalDrafts(newerTarget.anchor.sourceId)).toEqual([newerDraft]);
    expect(
      (await original.listReviewDrafts(newerTarget.anchor.sourceId)).map((item) => item.id),
    ).toEqual([draft.id, newerDraft.id]);
    await original.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'draft targets must resolve to an available committed side and an exact original range',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const target = await draftTarget(manager);
    for (const anchor of [
      { ...target.anchor, path: 'different.ts' },
      { ...target.anchor, commit: context.base },
      { ...target.anchor, blob: context.base },
      {
        ...target.anchor,
        range: { startLine: 0, startCharacter: 0, endLine: 999, endCharacter: 0 },
      },
    ]) {
      await expect(manager.createLocalDraft({ ...target, anchor })).rejects.toMatchObject({
        code: 'INVALID_SOURCE',
      });
    }
    const result = await manager.readCommittedSource(target.anchor.sourceId);
    if (result.status !== 'ready') throw new Error(result.detail);
    const deleted = result.source.files.find((file) => file.path === 'delete.py')!;
    const absent = await manager.readCommittedFile(result.source.id, deleted.id, 'new');
    if (absent.status !== 'absent') throw new Error('Expected absent committed side');
    await expect(
      manager.createLocalDraft({
        ...target,
        anchor: {
          ...absent.anchor,
          range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DRAFT' });
    const original = await manager.readCommittedFile(result.source.id, deleted.id, 'old');
    if (original.status !== 'available') throw new Error(original.detail);
    const oldTarget = {
      ...target,
      anchor: {
        ...original.anchor,
        range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 },
      },
    };
    expect(await manager.createLocalDraft(oldTarget)).toMatchObject({ target: oldTarget });
    expect(await manager.listLocalDrafts(result.source.id)).toHaveLength(1);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test('committed save receipts survive account fencing and retain newer pending input', async () => {
  const context = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const manager = context.manager(undefined, (store) => ({
    async request(request) {
      const reply = await store.request(request);
      if (request.action === 'saveDraft' && !held) {
        held = true;
        entered();
        await gate;
      }
      return reply;
    },
    dispose: () => store.dispose(),
  }));
  await manager.openPullRequestOverview(context.pullRequest.url);
  const draft = await manager.createLocalDraft(await draftTarget(manager));
  const writer = await manager.openDraftWriter(draft.id);
  manager.editDraftWriter(writer.writerId, 0, 'durably saved while account changed');
  const flush = manager.flushDraftWriter();
  await waiting;
  manager.fencePullRequestOverview();
  release();
  expect(await flush).toBe(true);
  await manager.openPullRequestOverview(context.pullRequest.url);
  const reopened = await manager.openDraftWriter(draft.id);
  expect(await manager.readLocalDraft(draft.id)).toMatchObject({
    committedRevision: 1,
    rowRevision: 2,
    body: 'durably saved while account changed',
  });
  expect(reopened).toMatchObject({ committedRevision: 1, rowRevision: 2, status: 'saved' });
  manager.editDraftWriter(reopened.writerId, 1, 'newer input after verification');
  expect(await manager.retryDraftWriter(reopened.writerId)).toBe(true);
  expect(await manager.closeDraftWriter(reopened.writerId)).toEqual(draft.target);
  expect(await manager.readLocalDraft(draft.id)).toMatchObject({
    body: 'newer input after verification',
    committedRevision: 2,
  });
  expect((await manager.releasePrivateStore()).status).toBe('closed');
}, 20000);

test('switching writers retains input received during discovery when its save fails', async () => {
  const context = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  let holdDraft: string | undefined;
  const manager = context.manager(
    { boundary: 'saveDraft.commit.before', mode: 'read-only' },
    (store) => ({
      async request(request) {
        const reply = await store.request(request);
        if (request.action === 'readDraft' && request.draftId === holdDraft && !held) {
          held = true;
          entered();
          await gate;
        }
        return reply;
      },
      dispose: () => store.dispose(),
    }),
  );
  await manager.openPullRequestOverview(context.pullRequest.url);
  const target = await draftTarget(manager);
  const first = await manager.createLocalDraft(target);
  const second = await manager.createLocalDraft(target);
  const original = await manager.openDraftWriter(first.id);
  holdDraft = second.id;
  const opening = manager.openDraftWriter(second.id);
  await waiting;
  manager.editDraftWriter(original.writerId, 0, 'host-received input during draft switch');
  release();
  await expect(opening).rejects.toMatchObject({ code: 'DRAFT_SAVE_FAILED' });
  expect(manager.readDraftWriter()).toMatchObject({
    id: first.id,
    body: 'host-received input during draft switch',
    status: 'failed',
  });
  expect(await manager.readLocalDraft(first.id)).toMatchObject({ body: '', committedRevision: 0 });
  expect(await manager.retryDraftWriter(original.writerId)).toBe(true);
  expect((await manager.openDraftWriter(second.id)).id).toBe(second.id);
  expect(await manager.readLocalDraft(first.id)).toMatchObject({
    body: 'host-received input during draft switch',
    committedRevision: 1,
  });
  await manager.releasePrivateStore();
}, 20000);

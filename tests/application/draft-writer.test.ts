import { expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  draftEditRequests,
  draftControlRequest,
  draftTransportBytes,
} from '../../src/protocol/drafts';

import { fixture, draftTarget, integrationTimeout } from '../support/review/committed-review';

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

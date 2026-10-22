import { expect, test } from 'vitest';

import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { fixture, draftTarget, integrationTimeout } from '../support/review/committed-review';

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

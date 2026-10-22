// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { randomUUID } from 'node:crypto';
import { fixture, draftTarget, integrationTimeout } from '../../support/review/committed-review';
import { DraftWriterClient } from '../../../src/webviews/drafts/client';
import { DraftWriterView } from '../../../src/webviews/drafts/writer-view';
import { draftSnapshotChunks } from '../../../src/protocol/drafts';
import type { StorageDiagnostics } from '../../../src/storage/diagnostics';

vi.hoisted(() => {
  // jsdom installs a different Uint8Array realm while Node's TextEncoder stays
  // native. esbuild needs those constructors to agree when bundling the worker.
  globalThis.Uint8Array = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;
});

// These interactions await real Git/worker/SQLite round trips. Windows CI can
// exceed RTL's one-second default before a durable acknowledgment arrives.
// Autosave scheduling deadlines are checked separately at the manager seam.
if (process.platform === 'win32') configure({ asyncUtilTimeout: 10_000 });

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of dispose.splice(0)) stop();
});
async function renderWriter(diagnostics?: StorageDiagnostics) {
  const context = await fixture();
  const manager = context.manager(diagnostics);
  await manager.openPullRequestOverview(context.pullRequest.url);
  const target = await draftTarget(manager);
  const draft = await manager.createLocalDraft(target);
  await manager.openDraftWriter(draft.id);
  const instance = randomUUID();
  const initial = manager.attachDraftWriter(instance);
  let closed = false;
  let paused = false;
  let failNext = false;
  let syncGate: Promise<void> | undefined;
  function deliver(snapshot: ReturnType<typeof manager.snapshotDraftWriter>, force = false) {
    if (!paused || force) for (const chunk of draftSnapshotChunks(snapshot)) client.receive(chunk);
  }
  const client = new DraftWriterClient(instance, (message) => {
    if (failNext && message.type === 'editChunk') {
      failNext = false;
      throw new Error('Fixture transport failure');
    }
    void (async () => {
      if (message.type === 'sync') await syncGate;
      return manager.handleDraftWriterMessage(message);
    })().then((result) => {
      if (result.snapshot) deliver(result.snapshot, message.type === 'sync');
      if (result.closedTarget) {
        expect(result.closedTarget).toEqual(target);
        closed = true;
      }
    });
  });
  const unsubscribe = manager.onDraftWriterChange(() => {
    deliver(manager.snapshotDraftWriter(instance));
  });
  dispose.push(() => {
    unsubscribe();
    client.dispose();
  });
  render(<DraftWriterView client={client} />);
  await act(async () => {
    for (const chunk of draftSnapshotChunks(initial)) client.receive(chunk);
  });
  return {
    manager,
    target,
    draft,
    client,
    instance,
    closed: () => closed,
    pause: () => {
      paused = true;
    },
    failNextEdit: () => {
      failNext = true;
    },
    holdSync: () => {
      let release!: () => void;
      syncGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    resume: () => {
      paused = false;
      deliver(manager.snapshotDraftWriter(instance, true));
    },
  };
}
test(
  'Close waiting for resynchronization retains rejected text if another writer opens',
  async () => {
    const { manager, target, holdSync } = await renderWriter();
    const other = await manager.createLocalDraft(target);
    const body = 'x'.repeat(1024 * 1024 + 1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: body },
    });
    const release = holdSync();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => {
      await manager.openDraftWriter(other.id);
      release();
    });
    const recovery = await screen.findByRole('textbox', {
      name: 'Recovery copy of private feedback',
    });
    expect((recovery as HTMLTextAreaElement).value).toBe(body);
    expect((await manager.readLocalDraft(other.id))?.body).toBe('');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);
test(
  'Retry resynchronizes before rebasing failed transport and preserves the newest input',
  async () => {
    const { manager, draft, pause, failNextEdit } = await renderWriter();
    pause();
    const input = screen.getByRole('textbox', { name: 'Private feedback' });
    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.change(input, { target: { value: 'second' } });
    await waitFor(() => expect(manager.readDraftWriter()?.editRevision).toBe(2));
    failNextEdit();
    fireEvent.change(input, { target: { value: 'newest unreceived input' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(manager.readDraftWriter()?.body).toBe('newest unreceived input'));
    expect((input as HTMLTextAreaElement).value).toBe('newest unreceived input');
    await manager.flushDraftWriter();
    expect((await manager.readLocalDraft(draft.id))?.body).toBe('newest unreceived input');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'an older Saved projection cannot clear the failure and copy path for rejected input',
  async () => {
    const { manager, pause, resume } = await renderWriter();
    const input = screen.getByRole('textbox', { name: 'Private feedback' });
    fireEvent.change(input, { target: { value: 'valid earlier edit' } });
    await waitFor(() => expect(manager.readDraftWriter()?.editRevision).toBe(1));
    pause();
    const rejected = 'x'.repeat(1024 * 1024 + 1);
    fireEvent.change(input, { target: { value: rejected } });
    await waitFor(() => expect(manager.readDraftWriter()?.status).toBe('saved'));
    await act(async () => {
      resume();
    });
    expect((input as HTMLTextAreaElement).value).toBe(rejected);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy input' })).toBeTruthy();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);
test(
  'trimming rejected input while host projections lag never replaces it with older text',
  async () => {
    const { manager, draft, pause, resume } = await renderWriter();
    pause();
    const input = screen.getByRole('textbox', { name: 'Private feedback' });
    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.change(input, { target: { value: 'second' } });
    await waitFor(() => expect(manager.readDraftWriter()?.editRevision).toBe(2));
    fireEvent.change(input, { target: { value: 'x'.repeat(1024 * 1024 + 1) } });
    fireEvent.change(input, { target: { value: 'latest trimmed input' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      resume();
    });
    expect((input as HTMLTextAreaElement).value).toBe('latest trimmed input');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Saved on this device/),
    );
    expect((await manager.readLocalDraft(draft.id))?.body).toBe('latest trimmed input');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Close with a dropped Saved projection completes without a false recovery copy',
  async () => {
    const { manager, draft, pause, resume, closed } = await renderWriter();
    pause();
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: 'saved by Close' },
    });
    await waitFor(() => expect(manager.readDraftWriter()?.editRevision).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(closed()).toBe(true));
    await act(async () => {
      resume();
    });
    expect(screen.queryByRole('textbox', { name: 'Recovery copy of private feedback' })).toBeNull();
    expect((await manager.readLocalDraft(draft.id))?.body).toBe('saved by Close');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);
test(
  'real typing, Preview and Escape save at the original target through the real worker',
  async () => {
    const { manager, target, draft, closed } = await renderWriter();
    const input = screen.getByRole('textbox', { name: 'Private feedback' });
    fireEvent.change(input, { target: { value: '**Unicode 🐈**\n\nunfinished ```' } });
    expect((input as HTMLTextAreaElement).value).toBe('**Unicode 🐈**\n\nunfinished ```');
    expect(screen.getByRole('status').textContent).toMatch(/Saving/);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(await screen.findByText('Unicode 🐈')).toBeTruthy();
    expect(screen.getByRole('tabpanel').querySelector('strong')?.textContent).toBe('Unicode 🐈');
    fireEvent.click(screen.getByRole('tab', { name: 'Write' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Saved on this device/),
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Private feedback' }), { key: 'Escape' });
    await waitFor(() => expect(closed()).toBe(true));
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      target,
      body: '**Unicode 🐈**\n\nunfinished ```',
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a failed Close retains the visible copy and original target, Retry saves it, and Discard deletes the same record',
  async () => {
    const { manager, target, draft, closed } = await renderWriter({
      boundary: 'saveDraft.commit.before',
      mode: 'read-only',
    });
    const input = screen.getByRole('textbox', { name: 'Private feedback' });
    fireEvent.change(input, { target: { value: 'retain this 🐈\n**unfinished' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(closed()).toBe(false);
    expect(
      (screen.getByRole('textbox', { name: 'Private feedback' }) as HTMLTextAreaElement).value,
    ).toBe('retain this 🐈\n**unfinished');
    expect(screen.getByRole('button', { name: 'Copy input' })).toBeTruthy();
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      target,
      body: '',
      committedRevision: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Saved on this device/),
    );
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      target,
      body: 'retain this 🐈\n**unfinished',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Private feedback' })).toBeNull(),
    );
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: '', deletionRevision: 3 });
    expect(await manager.listReviewDrafts(target.anchor.sourceId)).toEqual([]);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'oversize input stays visible for copying and trimming it resumes complete autosaving',
  async () => {
    const { manager, draft } = await renderWriter();
    const body = '🧪'.repeat(256 * 1024) + 'x';
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: body },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Private feedback' }) as HTMLTextAreaElement).value,
    ).toBe(body);
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({
      body: '',
      committedRevision: 0,
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: 'trimmed complete text' },
    });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Saved on this device/),
    );
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: 'trimmed complete text' });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'projection gaps resynchronize without replacing newer typing or treating an old Saved as current',
  async () => {
    const { manager, draft, client, instance } = await renderWriter();
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: 'first saved text' },
    });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Saved on this device/),
    );
    const delayed = manager.snapshotDraftWriter(instance);
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: 'newest visible text' },
    });
    await act(async () => {
      for (const chunk of draftSnapshotChunks(delayed)) client.receive(chunk);
    });
    expect(
      (screen.getByRole('textbox', { name: 'Private feedback' }) as HTMLTextAreaElement).value,
    ).toBe('newest visible text');
    expect(screen.getByRole('status').textContent).toMatch(/Saving/);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Saved on this device/),
    );
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: 'newest visible text' });
    await act(async () => {
      manager.snapshotDraftWriter(instance); // Simulate a lost projection before account fencing.
      manager.fencePullRequestOverview();
      expect(client.read().body).toBe('');
    });
    expect(screen.queryByRole('textbox', { name: 'Private feedback' })).toBeNull();
    expect(document.body.textContent).not.toContain('newest visible text');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'account fencing hides rejected browser input until its exact original draft is verified again',
  async () => {
    const { manager, target, draft, client } = await renderWriter();
    const body = '🧪'.repeat(256 * 1024) + 'browser-only';
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: body },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    await act(async () => {
      manager.fencePullRequestOverview();
    });
    expect(document.body.textContent).not.toContain('browser-only');
    expect(client.read().body).toBe('');
    await manager.openPullRequestOverview('https://github.com/base/project/pull/20');
    const other = await manager.createLocalDraft(target);
    await act(async () => {
      await manager.openDraftWriter(other.id);
    });
    expect(screen.queryByRole('textbox', { name: 'Recovery copy of private feedback' })).toBeNull();
    const secondBody = body + 'second original identity';
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: secondBody },
    });
    await act(async () => {
      manager.fencePullRequestOverview();
    });
    await manager.openPullRequestOverview('https://github.com/base/project/pull/20');
    await act(async () => {
      await manager.openDraftWriter(draft.id);
    });
    const recovery = await screen.findByRole('textbox', {
      name: 'Recovery copy of private feedback',
    });
    expect((recovery as HTMLTextAreaElement).value).toBe(body);
    fireEvent.click(screen.getByRole('button', { name: 'Close recovery copy' }));
    await act(async () => {
      await manager.openDraftWriter(other.id);
    });
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Recovery copy of private feedback',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(secondBody);
    expect((await manager.readLocalDraft(draft.id))?.body).toBe('');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a failed Discard keeps the input and Retry completes the deletion without restoring a browser copy',
  async () => {
    const { manager, draft } = await renderWriter({
      boundary: 'discardDraft.commit.before',
      mode: 'commit',
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private feedback' }), {
      target: { value: 'discard all of this unsaved input' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Private feedback' }) as HTMLTextAreaElement).value,
    ).toBe('discard all of this unsaved input');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Private feedback' })).toBeNull(),
    );
    expect(screen.queryByRole('textbox', { name: 'Recovery copy of private feedback' })).toBeNull();
    expect(await manager.readLocalDraft(draft.id)).toMatchObject({ body: '', deletionRevision: 2 });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

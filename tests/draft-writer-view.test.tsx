// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { randomUUID } from 'node:crypto';
import { fixture, draftTarget, integrationTimeout } from './fixtures/committed-review';
import { DraftWriterClient } from '../src/webviews/draft-client';
import { DraftWriterView } from '../src/webviews/draft-writer-view';
import { draftSnapshotChunks } from '../src/shared/draft-writer';
import type { StorageDiagnostics } from '../src/connections/storage-diagnostics';

vi.hoisted(() => {
  // jsdom installs a different Uint8Array realm while Node's TextEncoder stays
  // native. esbuild needs those constructors to agree when bundling the worker.
  globalThis.Uint8Array = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;
});

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
  const client = new DraftWriterClient(instance, (message) => {
    void manager.handleDraftWriterMessage(message).then((result) => {
      if (result.snapshot)
        for (const chunk of draftSnapshotChunks(result.snapshot)) client.receive(chunk);
      if (result.closedTarget) {
        expect(result.closedTarget).toEqual(target);
        closed = true;
      }
    });
  });
  const unsubscribe = manager.onDraftWriterChange(() => {
    for (const chunk of draftSnapshotChunks(manager.snapshotDraftWriter(instance)))
      client.receive(chunk);
  });
  dispose.push(() => {
    unsubscribe();
    client.dispose();
  });
  render(<DraftWriterView client={client} />);
  await act(async () => {
    for (const chunk of draftSnapshotChunks(initial)) client.receive(chunk);
  });
  return { manager, target, draft, client, instance, closed: () => closed };
}
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

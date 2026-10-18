import { randomUUID } from 'node:crypto';
import { StoreError } from './private-store';
import {
  validDraftBody,
  type LocalDraft,
  type DraftEdit,
  type DraftDiscard,
  type DraftCommit,
  type DraftWriterProjection,
} from './local-draft';

interface DraftWriterStorage {
  read(id: string): Promise<LocalDraft | undefined>;
  save(edit: DraftEdit): Promise<DraftCommit>;
  discard(change: DraftDiscard): Promise<DraftCommit>;
  authority(): { incarnation: string; fence: number } | undefined;
}
interface Writer {
  record: LocalDraft;
  writerId: string;
  authority: { incarnation: string; fence: number };
  body: string;
  editRevision: number;
  status: DraftWriterProjection['status'];
  detail: string;
  pendingSince?: number | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  inFlight?: Promise<void> | undefined;
  closing: boolean;
  discarding: boolean;
  failedDiscard: boolean;
}

// Owned by the manager. Neither view disposal nor a browser timer owns a save.
export class DraftWriter {
  private current: Writer | undefined;
  private opening = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: DraftWriterStorage) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
  read(): DraftWriterProjection | undefined {
    const state = this.current;
    const authority = this.storage.authority();
    if (
      !state ||
      !authority ||
      authority.incarnation !== state.authority.incarnation ||
      authority.fence !== state.authority.fence
    )
      return undefined;
    return structuredClone({
      ...state.record,
      ...state.authority,
      writerId: state.writerId,
      body: state.body,
      editRevision: state.editRevision,
      status: state.status,
      detail: state.detail,
    });
  }
  async open(id: string): Promise<DraftWriterProjection> {
    const opening = ++this.opening;
    if (this.current?.record.id !== id && !(await this.flush()))
      throw new StoreError(
        'DRAFT_SAVE_FAILED',
        'Keep this writer open and Retry its unsaved text before opening another draft.',
      );
    const record = await this.storage.read(id);
    const authority = this.storage.authority();
    if (opening !== this.opening)
      throw new StoreError('DRAFT_SUPERSEDED', 'A newer draft replaced this open request.');
    if (!record || record.deletionRevision || !authority)
      throw new StoreError(
        'DRAFT_UNAVAILABLE',
        'This original draft is unavailable or was discarded.',
      );
    if (this.current?.record.id === id && this.read()) return this.read()!;
    this.current = {
      record,
      authority,
      writerId: randomUUID(),
      body: record.body,
      editRevision: record.editRevision,
      status: 'saved',
      detail: 'Saved on this device',
      closing: false,
      discarding: false,
      failedDiscard: false,
    };
    this.changed();
    return this.read()!;
  }
  edit(writerId: string, expectedEditRevision: number, body: string): DraftWriterProjection {
    const state = this.require(writerId);
    if (
      state.closing ||
      state.discarding ||
      expectedEditRevision !== state.editRevision ||
      !Number.isSafeInteger(expectedEditRevision) ||
      expectedEditRevision === Number.MAX_SAFE_INTEGER ||
      !validDraftBody(body)
    )
      throw new StoreError(
        'DRAFT_INPUT_REJECTED',
        'This change is stale, incomplete or exceeds 1 MiB UTF-8. Keep a copy of the visible input and resynchronize before Retry.',
      );
    state.body = body;
    state.editRevision += 1;
    state.pendingSince ??= Date.now();
    state.failedDiscard = false;
    state.status = 'saving';
    state.detail = 'Saving on this device…';
    this.schedule(state);
    this.changed();
    return this.read()!;
  }
  private require(writerId: string): Writer {
    if (!this.current || !this.read() || this.current.writerId !== writerId)
      throw new StoreError(
        'DRAFT_WRITER_STALE',
        'This writer no longer owns the original draft. Keep a copy of unsaved input and reopen its original account and target.',
      );
    return this.current;
  }
  private cancelTimer(state: Writer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  private schedule(state: Writer) {
    this.cancelTimer(state);
    const due = Math.min(Date.now() + 300, (state.pendingSince ?? Date.now()) + 1000);
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        void this.save(state);
      },
      Math.max(0, due - Date.now()),
    );
  }
  private save(state: Writer): Promise<void> {
    if (state.inFlight) return state.inFlight;
    this.cancelTimer(state);
    if (state.discarding || state.editRevision === state.record.committedRevision)
      return Promise.resolve();
    const body = state.body,
      editRevision = state.editRevision;
    state.pendingSince = undefined;
    state.status = 'saving';
    state.detail = 'Saving on this device…';
    this.changed();
    const work = (async () => {
      try {
        const receipt = await this.storage.save({
          requestId: randomUUID(),
          draftId: state.record.id,
          reviewId: state.record.reviewId,
          contentGeneration: state.record.contentGeneration,
          expectedRowRevision: state.record.rowRevision,
          expectedCommittedRevision: state.record.committedRevision,
          editRevision,
          body,
        });
        if (
          receipt.draftId !== state.record.id ||
          receipt.reviewId !== state.record.reviewId ||
          receipt.contentGeneration !== state.record.contentGeneration ||
          receipt.editRevision !== editRevision ||
          receipt.committedRevision !== editRevision ||
          receipt.rowRevision !== state.record.rowRevision + 1 ||
          receipt.deletionRevision !== 0
        )
          throw new StoreError(
            'DRAFT_RECEIPT_UNKNOWN',
            'The worker did not acknowledge this exact edit. Preserve the visible input and check recovery.',
          );
        state.record = {
          ...state.record,
          body,
          editRevision,
          committedRevision: receipt.committedRevision,
          rowRevision: receipt.rowRevision,
        };
        state.status = state.editRevision === editRevision ? 'saved' : 'saving';
        state.detail = state.status === 'saved' ? 'Saved on this device' : 'Saving newer input…';
      } catch (error) {
        state.status = 'failed';
        state.detail =
          error instanceof Error
            ? error.message
            : 'The draft did not save. Keep the input and Retry.';
      } finally {
        state.inFlight = undefined;
        this.changed();
        if (
          !state.closing &&
          !state.discarding &&
          state.status !== 'failed' &&
          state.editRevision > state.record.committedRevision
        )
          this.schedule(state);
      }
    })();
    state.inFlight = work;
    return work;
  }
  async flush(): Promise<boolean> {
    const state = this.current;
    if (!state) return true;
    this.cancelTimer(state);
    if (state.discarding) return false;
    while (state.editRevision > state.record.committedRevision) {
      await this.save(state);
      if (state.status === 'failed') return false;
    }
    return true;
  }
  async retry(writerId: string): Promise<boolean> {
    const state = this.require(writerId);
    if (state.failedDiscard) return this.discard(writerId);
    return this.flush();
  }
  async close(writerId: string): Promise<LocalDraft['target'] | undefined> {
    const state = this.require(writerId);
    if (state.closing || state.discarding)
      throw new StoreError('DRAFT_BUSY', 'Wait for the current writer action to finish.');
    state.closing = true;
    if (!(await this.flush())) {
      state.closing = false;
      this.changed();
      return undefined;
    }
    this.current = undefined;
    this.changed();
    return structuredClone(state.record.target);
  }
  async discard(writerId: string): Promise<boolean> {
    const state = this.require(writerId);
    if (state.closing || state.discarding)
      throw new StoreError('DRAFT_BUSY', 'Wait for the current writer action to finish.');
    this.cancelTimer(state);
    state.discarding = true;
    state.status = 'discarding';
    state.detail = 'Discarding local draft…';
    this.changed();
    if (state.inFlight) await state.inFlight;
    try {
      const receipt = await this.storage.discard({
        requestId: randomUUID(),
        draftId: state.record.id,
        reviewId: state.record.reviewId,
        contentGeneration: state.record.contentGeneration,
        expectedRowRevision: state.record.rowRevision,
        expectedCommittedRevision: state.record.committedRevision,
      });
      if (
        receipt.draftId !== state.record.id ||
        receipt.deletionRevision !== state.record.rowRevision + 1
      )
        throw new StoreError(
          'DRAFT_RECEIPT_UNKNOWN',
          'Discard was not acknowledged. Keep the input and check recovery.',
        );
      this.current = undefined;
      this.changed();
      return true;
    } catch (error) {
      state.discarding = false;
      state.failedDiscard = true;
      state.status = 'failed';
      state.detail = error instanceof Error ? error.message : 'Discard did not commit. Retry.';
      this.changed();
      return false;
    }
  }
  reset() {
    if (this.current) this.cancelTimer(this.current);
    this.current = undefined;
    this.opening += 1;
    this.changed();
  }
  fence() {
    if (this.current) this.current.writerId = randomUUID();
  }
}

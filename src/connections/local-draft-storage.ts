import type { DatabaseSync } from 'node:sqlite';
import type { LocalDraft, DraftVersion } from '../application/local-draft';
import { StoreError } from '../application/private-store';
import { object, recovery, sequence, uuid } from './store-records';

const mutations = "('createDraft','saveDraft','discardDraft')";

export function draftWriteError(error: unknown): Error {
  if (error instanceof StoreError && error.code !== 'INJECTED_IO') return error;
  if (
    (error instanceof StoreError && error.code === 'INJECTED_IO') ||
    (object(error) &&
      error.code === 'ERR_SQLITE_ERROR' &&
      typeof error.errcode === 'number' &&
      [5, 6, 8, 10, 13, 19].includes(error.errcode & 0xff))
  )
    return new StoreError(
      'DRAFT_WRITE_FAILED',
      'The draft write did not commit. Keep the original input and target, check disk space / private-store access and Retry.',
    );
  // Corruption, an unrecognized driver failure or uncertain rollback must not
  // turn into an ordinary Retry loop on this connection.
  return error instanceof Error
    ? error
    : new StoreError(
        'STORE_UNAVAILABLE',
        'The draft write outcome is unknown. Preserve the input and check private-store recovery.',
      );
}

function draftFromResult(result: unknown): LocalDraft {
  const draft = JSON.parse(String(result)).draft as LocalDraft | undefined;
  if (
    !draft ||
    !uuid(draft.id) ||
    !uuid(draft.reviewId) ||
    !sequence(draft.contentGeneration) ||
    draft.contentGeneration < 1 ||
    !sequence(draft.rowRevision) ||
    draft.rowRevision < 1 ||
    !sequence(draft.editRevision) ||
    draft.editRevision !== draft.committedRevision ||
    !sequence(draft.deletionRevision) ||
    typeof draft.body !== 'string'
  )
    recovery('An anchored draft record is malformed.');
  return draft;
}

export function readDraft(
  database: DatabaseSync,
  scopeId: string,
  draftId: string,
): LocalDraft | undefined {
  if (!uuid(draftId))
    throw new StoreError('INVALID_DRAFT', 'An opaque draft identity is required.');
  const row = database
    .prepare(
      `SELECT result FROM requests WHERE scope_id=? AND action IN ${mutations}
     AND json_extract(result,'$.draft.id')=? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(scopeId, draftId);
  return row ? draftFromResult(row.result) : undefined;
}

export function reviewDraft(
  database: DatabaseSync,
  scopeId: string,
  review: LocalDraft['review'],
): LocalDraft | undefined {
  const row = database
    .prepare(
      `SELECT result FROM requests WHERE scope_id=? AND action IN ${mutations}
     AND json_extract(result,'$.draft.review.baseRepositoryId')=?
     AND json_extract(result,'$.draft.review.pullNumber')=? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(scopeId, review.baseRepositoryId, review.pullNumber);
  return row ? draftFromResult(row.result) : undefined;
}

export function listDrafts(
  database: DatabaseSync,
  scopeId: string,
  sourceId: string,
): LocalDraft[] {
  const rows = database
    .prepare(
      `SELECT result FROM requests WHERE rowid IN (
       SELECT max(rowid) FROM requests WHERE scope_id=? AND action IN ${mutations}
       GROUP BY json_extract(result,'$.draft.id'))
     AND json_extract(result,'$.draft.target.anchor.sourceId')=?
     AND json_extract(result,'$.draft.deletionRevision')=0 ORDER BY rowid`,
    )
    .all(scopeId, sourceId);
  return rows.map((row) => draftFromResult(row.result));
}

// Retain only the latest body, plus small historical receipts/digests. Discard
// uses this same transaction to erase the body before publishing its barrier.
export function removeEarlierDraftBodies(database: DatabaseSync, scopeId: string, draftId: string) {
  database
    .prepare(
      `UPDATE requests SET result=json_set(result,'$.draft.body','')
     WHERE scope_id=? AND action IN ${mutations} AND json_extract(result,'$.draft.id')=?`,
    )
    .run(scopeId, draftId);
}

export function assertDraftVersion(
  value: unknown,
  draft: LocalDraft,
): asserts value is DraftVersion {
  if (
    !object(value) ||
    !uuid(value.draftId) ||
    !uuid(value.reviewId) ||
    !sequence(value.contentGeneration) ||
    !sequence(value.expectedRowRevision) ||
    !sequence(value.expectedCommittedRevision)
  )
    throw new StoreError('INVALID_DRAFT', 'A draft change requires its complete expected version.');
  if (draft.deletionRevision !== 0)
    throw new StoreError(
      'DRAFT_DELETED',
      'This draft was discarded. New writing needs a new identity.',
    );
  if (
    value.draftId !== draft.id ||
    value.reviewId !== draft.reviewId ||
    value.contentGeneration !== draft.contentGeneration ||
    value.expectedRowRevision !== draft.rowRevision ||
    value.expectedCommittedRevision !== draft.committedRevision
  )
    throw new StoreError(
      'DRAFT_CONFLICT',
      'This change belongs to an older or different draft version. Reopen the original draft; keep a copy of unsaved input.',
    );
}

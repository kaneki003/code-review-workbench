import type { SourceNavigation } from './committed-source';

export const maxDraftBytes = 1024 * 1024;
export const draftActions = [
  'createDraft',
  'saveDraft',
  'discardDraft',
  'readDraft',
  'listDrafts',
  'listReviewDrafts',
] as const;
export function isDraftAction(action: string): boolean {
  return (draftActions as readonly string[]).includes(action);
}

export interface LocalDraft {
  id: string;
  reviewId: string;
  review: { baseRepositoryId: string; pullNumber: number };
  contentGeneration: number;
  target: SourceNavigation;
  body: string;
  editRevision: number;
  committedRevision: number;
  rowRevision: number;
  deletionRevision: number;
}

export interface DraftVersion {
  draftId: string;
  reviewId: string;
  contentGeneration: number;
  expectedRowRevision: number;
  expectedCommittedRevision: number;
}
export interface DraftEdit extends DraftVersion {
  requestId: string;
  editRevision: number;
  body: string;
}
export interface DraftDiscard extends DraftVersion {
  requestId: string;
}
export type DraftWriterProjection = LocalDraft & {
  writerId: string;
  incarnation: string;
  fence: number;
  status: 'saving' | 'saved' | 'failed' | 'discarding';
  detail: string;
};
// A save acknowledgment identifies a committed edit. It carries no replacement
// text that could overwrite input typed while that save was in flight.
export interface DraftCommit {
  draftId: string;
  reviewId: string;
  contentGeneration: number;
  editRevision: number;
  committedRevision: number;
  rowRevision: number;
  deletionRevision: number;
}

export function validDraftBody(body: unknown): body is string {
  if (typeof body !== 'string' || body.length > maxDraftBytes) return false;
  const encoded = new TextEncoder().encode(body);
  // Reject ill-formed UTF-16 rather than let UTF-8 storage replace characters.
  return (
    encoded.byteLength <= maxDraftBytes &&
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded) === body
  );
}

export function draftCommit(draft: LocalDraft): DraftCommit {
  return {
    draftId: draft.id,
    reviewId: draft.reviewId,
    contentGeneration: draft.contentGeneration,
    editRevision: draft.editRevision,
    committedRevision: draft.committedRevision,
    rowRevision: draft.rowRevision,
    deletionRevision: draft.deletionRevision,
  };
}

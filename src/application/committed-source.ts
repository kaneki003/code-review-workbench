import type { ReviewCandidate } from './pull-request';

export type SourceSide = 'old' | 'new';
export interface CommittedFileSide {
  path: string;
  blob: string;
  mode: string;
}
export interface CommittedFile {
  id: string;
  fingerprint: string;
  path: string;
  status: string;
  old: CommittedFileSide | null;
  new: CommittedFileSide | null;
}
export interface SourcePlan {
  id: string;
  candidate: ReviewCandidate;
  headRef: string;
  baseRef: string;
}
export interface CommittedSource {
  id: string;
  candidate: ReviewCandidate;
  head: string;
  baseTip: string;
  mergeBase: string | null;
  method: 'merge-base-to-head';
  completeness: 'complete' | 'unavailable';
  limitations: string[];
  files: CommittedFile[];
}
export type SourceResult =
  | { status: 'ready'; source: CommittedSource }
  | { status: 'unavailable'; detail: string; sourceId?: string };

export interface SourceRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}
export interface SourceAnchor {
  sourceId: string;
  fileId: string;
  side: SourceSide;
  path: string;
  blob: string;
  commit: string;
  range: SourceRange;
}
export interface SourceNavigation {
  anchor: SourceAnchor;
  control: 'source' | 'diff';
  focus: 'editor' | 'files';
  column: number;
}
export type CommittedContent =
  | { status: 'available'; text: string; anchor: Omit<SourceAnchor, 'range'> }
  | { status: 'absent'; detail: string }
  | { status: 'binary' | 'lfs' | 'unavailable'; detail: string };

export function validRange(value: unknown): value is SourceRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as SourceRange;
  return (
    [range.startLine, range.startCharacter, range.endLine, range.endCharacter].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    (range.endLine > range.startLine ||
      (range.endLine === range.startLine && range.endCharacter >= range.startCharacter))
  );
}

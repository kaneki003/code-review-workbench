import {
  maxDraftBytes,
  validDraftBody,
  type DraftWriterProjection,
} from '../application/local-draft';
import { validRange, type SourceNavigation } from '../application/committed-source';

export const draftTransportBytes = 64 * 1024;
const chunkBytes = 44 * 1024; // Base64 and the finite envelope fit inside 64 KiB.
export const maxDraftSnapshotBytes = 8 * maxDraftBytes; // Includes JSON escaping.
export interface DraftSnapshot {
  version: 1;
  instanceId: string;
  sequence: number;
  reset: boolean;
  state?: DraftWriterProjection;
  problem?: string;
}
interface Envelope {
  version: 1;
  instanceId: string;
  requestId: string;
}
export interface DraftRequestAuthority {
  writerId: string;
  draftId: string;
  reviewId: string;
  incarnation: string;
  fence: number;
  contentGeneration: number;
  expectedEditRevision: number;
  expectedRowRevision: number;
  expectedCommittedRevision: number;
}
export interface DraftChunk {
  transferId: string;
  index: number;
  parts: number;
  byteLength: number;
  chunk: string;
}
export type DraftControl = 'retry' | 'close' | 'discard';
export type DraftRequest = Envelope &
  (
    | { type: 'ready' }
    | { type: 'sync' }
    | (DraftRequestAuthority &
        (
          | ({ type: 'editChunk' } & DraftChunk)
          | { type: 'applyEdit'; transferId: string; parts: number; byteLength: number }
          | { type: DraftControl }
        ))
  );
export type DraftSnapshotChunk = DraftChunk & {
  version: 1;
  type: 'draftSnapshotChunk';
  instanceId: string;
  sequence: number;
};
export interface DraftActionResult {
  accepted: boolean;
  duplicate?: boolean;
  snapshot?: DraftSnapshot;
  closedTarget?: SourceNavigation;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
}
function sequence(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function exactKeys(value: Record<string, unknown>, names: readonly string[]) {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}
const envelopeKeys = ['version', 'type', 'instanceId', 'requestId'];
const authorityKeys = [
  'writerId',
  'draftId',
  'reviewId',
  'incarnation',
  'fence',
  'contentGeneration',
  'expectedEditRevision',
  'expectedRowRevision',
  'expectedCommittedRevision',
];
const transferKeys = ['transferId', 'parts', 'byteLength'];
function validTransfer(value: Record<string, unknown>, limit: number) {
  return (
    identifier(value.transferId) &&
    sequence(value.byteLength) &&
    value.byteLength <= limit &&
    sequence(value.parts, 1) &&
    value.parts === Math.max(1, Math.ceil(value.byteLength / chunkBytes))
  );
}
function validChunk(value: Record<string, unknown>, limit: number) {
  return (
    validTransfer(value, limit) &&
    sequence(value.index) &&
    value.index < (value.parts as number) &&
    typeof value.chunk === 'string' &&
    value.chunk.length <= Math.ceil(chunkBytes / 3) * 4
  );
}
export function isDraftRequest(value: unknown): value is DraftRequest {
  if (
    !record(value) ||
    value.version !== 1 ||
    !identifier(value.instanceId) ||
    !identifier(value.requestId)
  )
    return false;
  if (value.type === 'ready' || value.type === 'sync') return exactKeys(value, envelopeKeys);
  if (!['editChunk', 'applyEdit', 'retry', 'close', 'discard'].includes(String(value.type)))
    return false;
  if (
    !['writerId', 'draftId', 'reviewId', 'incarnation'].every((key) => identifier(value[key])) ||
    !sequence(value.fence, 1) ||
    !sequence(value.contentGeneration, 1) ||
    !sequence(value.expectedEditRevision) ||
    !sequence(value.expectedRowRevision, 1) ||
    !sequence(value.expectedCommittedRevision) ||
    value.expectedEditRevision < value.expectedCommittedRevision
  )
    return false;
  const extras =
    value.type === 'editChunk'
      ? [...transferKeys, 'index', 'chunk']
      : value.type === 'applyEdit'
        ? transferKeys
        : [];
  return (
    exactKeys(value, [...envelopeKeys, ...authorityKeys, ...extras]) &&
    (value.type !== 'editChunk' || validChunk(value, maxDraftBytes)) &&
    (value.type !== 'applyEdit' || validTransfer(value, maxDraftBytes)) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= draftTransportBytes
  );
}

function encodeChunks(text: string, limit: number): DraftChunk[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limit)
    throw new Error('The complete payload exceeds its supported size. Keep the original input.');
  const transferId = crypto.randomUUID();
  const parts = Math.max(1, Math.ceil(bytes.byteLength / chunkBytes));
  return Array.from({ length: parts }, (_, index) => ({
    transferId,
    index,
    parts,
    byteLength: bytes.byteLength,
    chunk: btoa(
      String.fromCharCode(...bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes)),
    ),
  }));
}
export function draftAuthority(
  snapshot: DraftSnapshot,
  expectedEditRevision = snapshot.state?.editRevision,
): DraftRequestAuthority {
  const state = snapshot.state;
  if (!state || expectedEditRevision === undefined)
    throw new Error('Open the original draft before writing.');
  return {
    writerId: state.writerId,
    draftId: state.id,
    reviewId: state.reviewId,
    incarnation: state.incarnation,
    fence: state.fence,
    contentGeneration: state.contentGeneration,
    expectedEditRevision,
    expectedRowRevision: state.rowRevision,
    expectedCommittedRevision: state.committedRevision,
  };
}
export function draftEditRequests(
  snapshot: DraftSnapshot,
  body: string,
  expectedEditRevision = snapshot.state?.editRevision,
): DraftRequest[] {
  if (!validDraftBody(body))
    throw new Error(
      'Drafts support up to 1 MiB UTF-8. Keep a copy of this input; no shortened version was sent.',
    );
  const authority = draftAuthority(snapshot, expectedEditRevision);
  const chunks = encodeChunks(body, maxDraftBytes);
  const first = chunks[0]!;
  const envelope = { version: 1 as const, instanceId: snapshot.instanceId, ...authority };
  return [
    ...chunks.map((chunk) => ({
      ...envelope,
      requestId: crypto.randomUUID(),
      type: 'editChunk' as const,
      ...chunk,
    })),
    {
      ...envelope,
      requestId: crypto.randomUUID(),
      type: 'applyEdit',
      transferId: first.transferId,
      parts: first.parts,
      byteLength: first.byteLength,
    },
  ];
}
export function draftControlRequest(
  snapshot: DraftSnapshot,
  type: DraftControl,
  expectedEditRevision = snapshot.state?.editRevision,
): Extract<DraftRequest, { type: DraftControl }> {
  return {
    version: 1,
    type,
    instanceId: snapshot.instanceId,
    requestId: crypto.randomUUID(),
    ...draftAuthority(snapshot, expectedEditRevision),
  };
}

// One bounded complete payload per attached view. Parts can arrive in any order;
// a different transfer replaces incomplete data and never commits a prefix.
export class DraftChunkAssembly {
  private transfer:
    { id: string; parts: number; bytes: number; chunks: (Uint8Array | undefined)[] } | undefined;
  constructor(private readonly limit: number) {}
  clear() {
    this.transfer = undefined;
  }
  push(part: DraftChunk) {
    if (!validChunk(part as unknown as Record<string, unknown>, this.limit))
      throw new Error('Malformed or oversized chunk. Keep the original input and Retry.');
    if (this.transfer?.id !== part.transferId)
      this.transfer = {
        id: part.transferId,
        parts: part.parts,
        bytes: part.byteLength,
        chunks: Array.from({ length: part.parts }),
      };
    const transfer = this.transfer;
    if (transfer.parts !== part.parts || transfer.bytes !== part.byteLength)
      throw new Error('The payload changed during transfer. Retry the complete input.');
    const binary = atob(part.chunk);
    if (
      btoa(binary) !== part.chunk ||
      binary.length !== Math.min(chunkBytes, part.byteLength - part.index * chunkBytes)
    )
      throw new Error('Invalid chunk encoding or length. No partial input was saved.');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const previous = transfer.chunks[part.index];
    if (previous && previous.some((byte, index) => byte !== bytes[index]))
      throw new Error('A chunk identity was reused with different input.');
    transfer.chunks[part.index] = bytes;
  }
  get complete() {
    return Boolean(this.transfer && this.transfer.chunks.every((chunk) => chunk !== undefined));
  }
  finish(transferId: string, parts: number, byteLength: number): string {
    const transfer = this.transfer;
    if (
      !transfer ||
      transfer.id !== transferId ||
      transfer.parts !== parts ||
      transfer.bytes !== byteLength ||
      !this.complete
    )
      throw new Error(
        'The draft payload is incomplete. Keep a copy of the visible input and Retry.',
      );
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      bytes.set(chunk!, offset);
      offset += chunk!.length;
    }
    this.clear();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
}
export function draftSnapshotChunks(snapshot: DraftSnapshot): DraftSnapshotChunk[] {
  return encodeChunks(JSON.stringify(snapshot), maxDraftSnapshotBytes).map((chunk) => ({
    version: 1,
    type: 'draftSnapshotChunk',
    instanceId: snapshot.instanceId,
    sequence: snapshot.sequence,
    ...chunk,
  }));
}
export function isDraftSnapshotChunk(value: unknown): value is DraftSnapshotChunk {
  return (
    record(value) &&
    exactKeys(value, [
      'version',
      'type',
      'instanceId',
      'sequence',
      ...transferKeys,
      'index',
      'chunk',
    ]) &&
    value.version === 1 &&
    value.type === 'draftSnapshotChunk' &&
    identifier(value.instanceId) &&
    sequence(value.sequence, 1) &&
    validChunk(value, maxDraftSnapshotBytes) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= draftTransportBytes
  );
}
function validNavigation(value: unknown): value is SourceNavigation {
  if (!record(value) || !record(value.anchor)) return false;
  const anchor = value.anchor;
  return (
    ['source', 'diff'].includes(String(value.control)) &&
    ['editor', 'files'].includes(String(value.focus)) &&
    sequence(value.column, 1) &&
    value.column <= 9 &&
    identifier(anchor.sourceId) &&
    typeof anchor.fileId === 'string' &&
    /^[a-f0-9]{64}$/.test(anchor.fileId) &&
    ['old', 'new'].includes(String(anchor.side)) &&
    typeof anchor.path === 'string' &&
    anchor.path.length <= 32768 &&
    typeof anchor.commit === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(anchor.commit) &&
    typeof anchor.blob === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(anchor.blob) &&
    validRange(anchor.range)
  );
}
export function isDraftSnapshot(value: unknown): value is DraftSnapshot {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['version', 'instanceId', 'sequence', 'reset', 'state', 'problem'].includes(key),
    ) ||
    value.version !== 1 ||
    !identifier(value.instanceId) ||
    !sequence(value.sequence, 1) ||
    typeof value.reset !== 'boolean' ||
    (value.problem !== undefined &&
      (typeof value.problem !== 'string' || value.problem.length > 4096))
  )
    return false;
  if (value.state === undefined) return true;
  const state = value.state;
  return (
    record(state) &&
    ['id', 'reviewId', 'writerId', 'incarnation'].every((key) => identifier(state[key])) &&
    record(state.review) &&
    typeof state.review.baseRepositoryId === 'string' &&
    /^[1-9]\d{0,19}$/.test(state.review.baseRepositoryId) &&
    sequence(state.review.pullNumber, 1) &&
    sequence(state.contentGeneration, 1) &&
    sequence(state.fence, 1) &&
    sequence(state.rowRevision, 1) &&
    state.deletionRevision === 0 &&
    sequence(state.editRevision) &&
    sequence(state.committedRevision) &&
    state.editRevision >= state.committedRevision &&
    ['saving', 'saved', 'failed', 'discarding'].includes(String(state.status)) &&
    (state.status !== 'saved' || state.editRevision === state.committedRevision) &&
    typeof state.detail === 'string' &&
    state.detail.length <= 4096 &&
    validNavigation(state.target) &&
    validDraftBody(state.body)
  );
}

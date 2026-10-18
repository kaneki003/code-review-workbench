import { createHash } from 'node:crypto';
import { maxDraftBytes } from './local-draft';
import type { DraftWriter } from './draft-writer';
import {
  DraftChunkAssembly,
  identifier,
  record,
  isDraftRequest,
  type DraftSnapshot,
  type DraftActionResult,
  type DraftRequest,
} from '../shared/draft-writer';

export class DraftWriterProtocol {
  private instanceId: string | undefined;
  private sequence = 0;
  private problem: string | undefined;
  private readonly input = new DraftChunkAssembly(maxDraftBytes);
  private readonly requests = new Map<
    string,
    { digest: string; result: Promise<DraftActionResult> }
  >();
  constructor(private readonly writer: DraftWriter) {}
  attach(instanceId: string): DraftSnapshot {
    if (!identifier(instanceId)) throw new Error('A fresh view identity is required.');
    this.instanceId = instanceId;
    this.sequence = 0;
    this.invalidate();
    return this.snapshot(instanceId, true);
  }
  detach(instanceId: string) {
    if (instanceId !== this.instanceId) return;
    this.instanceId = undefined;
    this.invalidate();
  }
  invalidate() {
    this.input.clear();
    this.requests.clear();
    this.problem = undefined;
  }
  snapshot(instanceId: string, reset = false): DraftSnapshot {
    if (instanceId !== this.instanceId) throw new Error('This view is detached.');
    const state = this.writer.read();
    return {
      version: 1,
      instanceId,
      sequence: ++this.sequence,
      reset,
      fenced: !this.writer.authorized,
      ...(state ? { state } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }
  async handle(value: unknown): Promise<DraftActionResult> {
    if (!record(value) || value.instanceId !== this.instanceId || !this.instanceId)
      return { accepted: false };
    try {
      if (!isDraftRequest(value))
        throw new Error(
          'Unsupported, malformed or oversized writer message. Keep the original input and Retry.',
        );
      if (value.type === 'ready' || value.type === 'sync')
        return { accepted: true, snapshot: this.snapshot(this.instanceId, true) };
      const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const prior = this.requests.get(value.requestId);
      if (prior) {
        if (prior.digest !== digest)
          throw new Error(
            'A request identity was reused with different input. No replacement was saved.',
          );
        return { ...(await prior.result), duplicate: true };
      }
      const result = this.apply(value);
      this.requests.set(value.requestId, { digest, result });
      if (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value!);
      return await result;
    } catch (error) {
      this.input.clear();
      this.problem =
        error instanceof Error
          ? error.message.slice(0, 4096)
          : 'The writer request failed. Keep a copy of the input and Retry.';
      this.writer.changed();
      return { accepted: false };
    }
  }
  private async apply(
    message: Exclude<DraftRequest, { type: 'ready' | 'sync' }>,
  ): Promise<DraftActionResult> {
    const state = this.writer.read();
    if (
      !state ||
      message.writerId !== state.writerId ||
      message.draftId !== state.id ||
      message.reviewId !== state.reviewId ||
      message.incarnation !== state.incarnation ||
      message.fence !== state.fence ||
      message.contentGeneration !== state.contentGeneration ||
      message.expectedRowRevision > state.rowRevision ||
      message.expectedCommittedRevision > state.committedRevision ||
      message.expectedEditRevision !== state.editRevision
    )
      throw new Error(
        'The view or draft revision changed. Keep a copy of the input and resynchronize its original target.',
      );
    if (message.type === 'editChunk') {
      this.input.push(message);
      return { accepted: true };
    }
    if (message.type === 'applyEdit') {
      const body = this.input.finish(message.transferId, message.parts, message.byteLength);
      this.problem = undefined;
      this.writer.edit(message.writerId, message.expectedEditRevision, body);
      return { accepted: true };
    }
    this.problem = undefined;
    if (message.type === 'close') {
      const closedTarget = await this.writer.close(message.writerId);
      return { accepted: Boolean(closedTarget), ...(closedTarget ? { closedTarget } : {}) };
    }
    if (message.type === 'discard')
      return { accepted: await this.writer.discard(message.writerId) };
    return { accepted: await this.writer.retry(message.writerId) };
  }
}

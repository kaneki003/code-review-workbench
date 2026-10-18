import {
  DraftChunkAssembly,
  maxDraftSnapshotBytes,
  isDraftSnapshot,
  isDraftSnapshotChunk,
  draftEditRequests,
  draftControlRequest,
  type DraftSnapshot,
  type DraftRequest,
  type DraftControl,
} from '../shared/draft-writer';

interface ClientState {
  snapshot: DraftSnapshot | undefined;
  body: string;
  editRevision: number;
  problem: string | undefined;
  action: DraftControl | undefined;
  recovery: { body: string; label: string } | undefined;
}
// Temporary presentation/input only. The host owns received pending text and
// storage; a transport acknowledgment is never a durable Saved acknowledgment.
export class DraftWriterClient {
  private state: ClientState = {
    snapshot: undefined,
    body: '',
    editRevision: 0,
    problem: undefined,
    action: undefined,
    recovery: undefined,
  };
  private readonly assembly = new DraftChunkAssembly(maxDraftSnapshotBytes);
  private incomingSequence = 0;
  private syncing = false;
  private discardRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly instanceId: string,
    private readonly post: (message: DraftRequest) => void,
  ) {}
  read = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<ClientState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  connect() {
    this.send({
      version: 1,
      type: 'ready',
      instanceId: this.instanceId,
      requestId: crypto.randomUUID(),
    });
  }
  private send(message: DraftRequest) {
    try {
      this.post(message);
    } catch {
      this.fail('The host did not receive this input. Keep a copy and Retry.');
    }
  }
  private fail(problem: string) {
    this.update({ problem, action: undefined });
  }
  private watch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail('The latest input has not been acknowledged. Keep a copy and Retry.'),
      12_000,
    );
  }
  private sync() {
    if (this.syncing) return;
    this.syncing = true;
    this.send({
      version: 1,
      type: 'sync',
      instanceId: this.instanceId,
      requestId: crypto.randomUUID(),
    });
  }
  receive(value: unknown) {
    if (
      !isDraftSnapshotChunk(value) ||
      value.instanceId !== this.instanceId ||
      value.sequence <= (this.state.snapshot?.sequence ?? 0)
    )
      return;
    try {
      if (value.sequence !== this.incomingSequence) {
        this.incomingSequence = value.sequence;
        this.assembly.clear();
      }
      this.assembly.push(value);
      if (!this.assembly.complete) return;
      const snapshot: unknown = JSON.parse(
        this.assembly.finish(value.transferId, value.parts, value.byteLength),
      );
      if (
        !isDraftSnapshot(snapshot) ||
        snapshot.instanceId !== this.instanceId ||
        snapshot.sequence !== value.sequence
      )
        throw new Error('The host projection was malformed. Keep the input and Retry.');
      const previous = this.state.snapshot;
      if (snapshot.fenced) {
        this.discardRequested = false;
        clearTimeout(this.timer);
        this.update({
          snapshot,
          body: '',
          editRevision: 0,
          recovery: undefined,
          action: undefined,
          problem: undefined,
        });
        return;
      }
      if (previous && snapshot.sequence !== previous.sequence + 1 && !snapshot.reset) {
        this.sync();
        return;
      }
      if (snapshot.reset) this.syncing = false;
      let { body, editRevision, recovery, action } = this.state;
      const next = snapshot.state;
      if (next?.writerId !== previous?.state?.writerId) {
        if (
          previous?.state &&
          action !== 'discard' &&
          !this.discardRequested &&
          editRevision > previous.state.committedRevision &&
          !recovery
        )
          recovery = {
            body,
            label: `PR #${previous.state.review.pullNumber} · ${previous.state.target.anchor.path} · ${previous.state.target.anchor.commit.slice(0, 8)}`,
          };
        body = next?.body ?? '';
        editRevision = next?.editRevision ?? 0;
        action = undefined;
        this.discardRequested = false;
      } else if (next && next.editRevision > editRevision) {
        body = next.body;
        editRevision = next.editRevision;
      } else if (next && next.editRevision === editRevision && next.body !== body) {
        this.fail('The host projection disagrees with the visible input. Keep a copy and Retry.');
        this.sync();
        return;
      }
      if (
        !next ||
        next.status === 'failed' ||
        (action === 'retry' && next.committedRevision === editRevision)
      )
        action = undefined;
      if (next && next.editRevision >= editRevision) clearTimeout(this.timer);
      this.update({ snapshot, body, editRevision, recovery, action, problem: snapshot.problem });
    } catch (error) {
      this.assembly.clear();
      this.fail(
        error instanceof Error
          ? error.message
          : 'The projection is incomplete. Keep the input and Retry.',
      );
      this.sync();
    }
  }
  edit(body: string): boolean {
    const snapshot = this.state.snapshot;
    if (!snapshot?.state || this.state.action || this.state.recovery) return false;
    const expected = this.state.problem ? snapshot.state.editRevision : this.state.editRevision;
    this.discardRequested = false;
    this.update({ body, editRevision: expected + 1, problem: undefined });
    try {
      const requests = draftEditRequests(snapshot, body, expected);
      this.watch();
      for (const request of requests) this.send(request);
      return true;
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : 'This input could not be sent. Keep a copy.',
      );
      return false;
    }
  }
  control(type: DraftControl) {
    const snapshot = this.state.snapshot;
    if (!snapshot?.state) {
      this.sync();
      return;
    }
    if (this.state.action) return;
    if (type === 'discard') this.discardRequested = true;
    if (type === 'close') this.discardRequested = false;
    try {
      if (this.state.problem && type !== 'discard') {
        const requests = draftEditRequests(snapshot, this.state.body, snapshot.state.editRevision);
        this.update({ editRevision: snapshot.state.editRevision + 1, problem: undefined });
        for (const request of requests) this.send(request);
      }
      const expected =
        type === 'discard' && this.state.problem
          ? snapshot.state.editRevision
          : this.state.editRevision;
      this.update({ action: type });
      this.watch();
      this.send(draftControlRequest(snapshot, type, expected));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Keep the input and Retry.');
    }
  }
  dismissRecovery() {
    this.update({ recovery: undefined });
  }
  dispose() {
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}

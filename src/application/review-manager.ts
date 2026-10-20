import type { Capability, ReadinessReport } from '../shared/readiness';
import { randomUUID } from 'node:crypto';
import {
  StoreError,
  type StoreConnection,
  type StoreLease,
  type StoreRequest,
  type StoreView,
  type StoreReply,
  type StoreHandoff,
} from './private-store';
import {
  sameLocalRepository,
  GitHubAccount,
  GitHubConnection,
  type LocalRepositoryConnection,
  type PullRequestOverview,
  type ReviewCandidate,
} from './pull-request';
import type {
  CommittedContent,
  SourceResult,
  SourceSide,
  SourceNavigation,
} from './committed-source';
import { isSourceAction } from './committed-source';
import {
  isCheckoutAction,
  type CheckoutEditors,
  type CheckoutResult,
  type CheckoutReview,
} from './checkout-review';
import { DraftWriter } from './draft-writer';
import { DraftWriterProtocol } from './draft-writer-protocol';
import {
  isDraftAction,
  type LocalDraft,
  type DraftEdit,
  type DraftDiscard,
  type DraftCommit,
} from './local-draft';

export interface HostEnvironment {
  vscode: string;
  node: string;
  electron: string | undefined;
  chrome: string | undefined;
  platform: string;
  arch: string;
  desktop: boolean;
  trusted: boolean;
  remote: string | undefined;
  folders: { scheme: string; path: string }[];
}

export interface ReviewConnections {
  environment(): HostEnvironment;
  git(folder: string): Promise<Capability>;
  sqlite(): Promise<Capability>;
  native(): Promise<Capability>;
  store?: StoreConnection;
  account?: Pick<GitHubAccount, 'host' | 'userId'>;
  github?: GitHubConnection;
  repository?: LocalRepositoryConnection;
  editors?: CheckoutEditors;
  confirmLocalRepository?(candidate: ReviewCandidate): Promise<boolean>;
}

// The owning manager coordinates actions independently of editor/view lifetime.
export class ReviewManager {
  private readonly draftWriter: DraftWriter;
  private readonly draftProtocol: DraftWriterProtocol;
  private storeLease: StoreLease | undefined;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private overviewGeneration = 0;
  private account: Pick<GitHubAccount, 'host' | 'userId'> | undefined;
  private sourceAuthorized: boolean;
  private checkoutQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly connections: ReviewConnections) {
    this.account = connections.account;
    this.sourceAuthorized = Boolean(connections.account);
    this.draftWriter = new DraftWriter({
      read: (id) => this.readLocalDraft(id),
      save: (edit) => this.saveLocalDraft(edit),
      discard: (change) => this.discardLocalDraft(change),
      authority: () =>
        this.sourceAuthorized && this.storeLease
          ? { incarnation: this.storeLease.incarnation, fence: this.storeLease.fence }
          : undefined,
    });
    this.draftProtocol = new DraftWriterProtocol(this.draftWriter);
  }
  async dispose(): Promise<void> {
    try {
      if (this.storeLease) await this.releasePrivateStore();
    } finally {
      this.draftWriter.reset();
      await this.connections.store?.dispose();
    }
  }

  openPrivateStore(handoff?: StoreHandoff): Promise<StoreView> {
    return this.storeRequest('open', {
      ...(handoff ? { handoff } : {}),
      ...(this.account ? { actor: this.account } : {}),
    }).then((reply) => reply.view);
  }
  async releasePrivateStore(): Promise<StoreView> {
    if (!(await this.draftWriter.flush()))
      return {
        status: 'recovery',
        code: 'DRAFT_SAVE_FAILED',
        detail:
          'The latest draft is not saved. Keep the writer open, copy the input if needed and Retry before releasing storage.',
      };
    this.draftWriter.reset();
    this.fencePullRequestOverview();
    return this.storeAction('release');
  }
  inspectPrivateStore(): Promise<StoreView> {
    return this.storeAction('inspect');
  }
  renewOwnership(): Promise<StoreView> {
    return this.storeAction('renew');
  }
  offerStoreHandoff(targetWindowId: string): Promise<StoreReply> {
    return this.storeRequest('handoff', { targetWindowId });
  }
  // Untyped legacy intent never authorizes execution or automatic recovery.
  // New operations must use the typed prepare/execute API below.
  recordRepositoryIntent(): Promise<StoreReply> {
    return this.storeRequest('recordIntent');
  }
  prepareReferenceUpdate(ref: string, newOid: string): Promise<StoreReply> {
    return this.storeRequest('prepareRef', { refUpdate: { ref, newOid } });
  }
  executeRepositoryOperation(operationId: string): Promise<StoreReply> {
    return this.storeRequest('executeOperation', { operationId });
  }
  // Low-level guarded transitions. The host lifecycle must retain editor state
  // before exposing these as Enter / Exit Review commands.
  prepareCleanCheckout(sourceId: string): Promise<StoreReply> {
    return this.storeRequest('prepareCleanCheckout', { sourceId });
  }
  prepareCleanRestore(operationId: string): Promise<StoreReply> {
    return this.storeRequest('prepareCleanRestore', { operationId });
  }
  async readCheckoutReview(): Promise<CheckoutReview | undefined> {
    const reply = await this.storeRequest('readCheckout');
    if (reply.view.status !== 'owned')
      throw new StoreError(reply.view.code ?? 'CHECKOUT_UNAVAILABLE', reply.view.detail);
    if (reply.checkout) this.connections.editors?.retain?.(reply.checkout.editors);
    return reply.checkout;
  }
  private checkoutWork(action: () => Promise<CheckoutResult>): Promise<CheckoutResult> {
    const result = this.checkoutQueue.then(action);
    this.checkoutQueue = result.catch(() => {});
    return result;
  }
  private checkoutReply(reply: StoreReply): CheckoutReview {
    if (!reply.checkout || reply.view.status !== 'owned')
      throw new StoreError(reply.view.code ?? 'CHECKOUT_RECOVERY', reply.view.detail);
    this.connections.editors?.retain?.(reply.checkout.editors);
    return reply.checkout;
  }
  private checkoutFailure(error: unknown, review?: CheckoutReview): CheckoutResult {
    return {
      status: review ? 'recovery' : 'blocked',
      detail: error instanceof Error ? error.message : 'The checkout transition needs recovery.',
      ...(review ? { review } : {}),
    };
  }
  enterPullRequestCheckout(sourceId: string): Promise<CheckoutResult> {
    return this.checkoutWork(async () => {
      let review: CheckoutReview | undefined;
      try {
        const existing = await this.readCheckoutReview();
        if (existing && existing.phase !== 'complete')
          return {
            status: 'recovery',
            detail:
              'A checkout is already saved. Resume or restore it through Recover PR Checkout.',
            review: existing,
          };
        const editors = this.connections.editors;
        if (!editors)
          throw new StoreError(
            'EDITOR_UNAVAILABLE',
            'Native editor save/capture is unavailable. Keep committed-source reading.',
          );
        const snapshot = await editors.capture();
        review = this.checkoutReply(
          await this.storeRequest('beginCheckout', { sourceId, editors: snapshot }),
        );
        return await this.continueCheckoutEntry(review);
      } catch (error) {
        return this.checkoutFailure(error, review);
      }
    });
  }
  private async continueCheckoutEntry(review: CheckoutReview): Promise<CheckoutResult> {
    this.connections.editors!.assertSaved();
    const prepared = await this.storeRequest(
      'prepareCleanCheckout',
      { sourceId: review.sourceId },
      undefined,
      review.entryId,
    );
    if (!prepared.operation)
      throw new StoreError(prepared.view.code ?? 'CHECKOUT_RECOVERY', prepared.view.detail);
    this.connections.editors!.assertSaved();
    const result = await this.executeRepositoryOperation(prepared.operation.id);
    if (result.operation?.outcome !== 'applied') {
      if (result.operation?.phase === 'observed') {
        const reconciled = this.checkoutReply(
          await this.storeRequest('reconcileCheckout', { checkoutChoice: 'restore' }),
        );
        if (reconciled.phase === 'restoring-editors') {
          await this.restoreCheckoutEditors(reconciled);
          return {
            status: 'blocked',
            detail:
              'PR checkout was refused. Your original checkout and editors were restored; continue no-switch reading.',
          };
        }
      }
      throw new StoreError(result.view.code ?? 'CHECKOUT_RECOVERY', result.view.detail);
    }
    this.connections.editors!.assertSaved();
    const active = this.checkoutReply(
      await this.storeRequest('activateCheckout', {
        checkoutId: review.id,
        checkoutRevision: review.revision,
      }),
    );
    return {
      status: 'active',
      detail: 'Active review: the owned checkout matches the exact inspected PR commit.',
      review: active,
    };
  }
  exitPullRequestCheckout(): Promise<CheckoutResult> {
    return this.checkoutWork(async () => {
      let review: CheckoutReview | undefined;
      try {
        review = await this.readCheckoutReview();
        if (!review)
          return {
            status: 'blocked',
            detail: 'No PR checkout is recorded in this account/local repository.',
          };
        return await this.exitCheckout(review);
      } catch (error) {
        return this.checkoutFailure(error, review);
      }
    });
  }
  private async exitCheckout(review: CheckoutReview): Promise<CheckoutResult> {
    if (review.phase === 'complete') return this.cleanupCheckout(review);
    if (!this.connections.editors)
      throw new StoreError(
        'EDITOR_UNAVAILABLE',
        'Native editor restoration is unavailable. The recovery snapshot is retained.',
      );
    await this.connections.editors.capture();
    if (review.phase === 'restoring-editors') return this.restoreCheckoutEditors(review);
    if (review.phase !== 'active')
      throw new StoreError(
        'CHECKOUT_RECOVERY',
        'This transition was interrupted. Use Recover PR Checkout before continuing Exit.',
      );
    review = this.checkoutReply(
      await this.storeRequest('beginCheckoutExit', {
        checkoutId: review.id,
        checkoutRevision: review.revision,
      }),
    );
    return this.continueCheckoutExit(review);
  }
  private async continueCheckoutExit(review: CheckoutReview): Promise<CheckoutResult> {
    this.connections.editors!.assertSaved();
    const prepared = await this.storeRequest(
      'prepareCleanRestore',
      { operationId: review.entryId },
      undefined,
      review.exitId!,
    );
    if (!prepared.operation)
      throw new StoreError(prepared.view.code ?? 'CHECKOUT_RECOVERY', prepared.view.detail);
    this.connections.editors!.assertSaved();
    const result = await this.executeRepositoryOperation(prepared.operation.id);
    if (result.operation?.outcome !== 'applied')
      throw new StoreError(
        result.view.code ?? 'CHECKOUT_RECOVERY',
        'Exit did not verify Git restoration. Preserve the transition and use Recover PR Checkout.',
      );
    review = this.checkoutReply(
      await this.storeRequest('finishCheckoutGit', {
        checkoutId: review.id,
        checkoutRevision: review.revision,
      }),
    );
    return this.restoreCheckoutEditors(review);
  }
  private async restoreCheckoutEditors(review: CheckoutReview): Promise<CheckoutResult> {
    this.connections.editors!.assertSaved();
    await this.connections.editors!.restore(review.editors);
    this.connections.editors!.assertSaved();
    const complete = this.checkoutReply(
      await this.storeRequest('completeCheckout', {
        checkoutId: review.id,
        checkoutRevision: review.revision,
      }),
    );
    return this.cleanupCheckout(complete);
  }
  private async cleanupCheckout(complete: CheckoutReview): Promise<CheckoutResult> {
    const cleanup = await this.storeRequest('cleanupCheckout', {
      checkoutId: complete.id,
      checkoutRevision: complete.revision,
    });
    if (cleanup.view.status !== 'owned')
      return {
        status: 'recovery',
        detail: `Git and editors were restored. Artifact cleanup needs recovery: ${cleanup.view.detail}`,
        review: complete,
      };
    return {
      status: 'complete',
      detail: `Exit complete: the original branch/commit, clean files and native editor state were verified.${cleanup.cleanup?.retained.length ? ' Recovery artifacts were retained to keep their unmerged, moved or uncertain commits reachable.' : ''}`,
      review: complete,
    };
  }
  recoverPullRequestCheckout(choice: 'continue' | 'restore'): Promise<CheckoutResult> {
    return this.checkoutWork(async () => {
      let review: CheckoutReview | undefined;
      try {
        if (!this.connections.editors)
          throw new StoreError('EDITOR_UNAVAILABLE', 'Native editor recovery is unavailable.');
        const ownership = await this.inspectPrivateStore();
        if (ownership.status === 'recovery' && ownership.code === 'OPERATION_PENDING') {
          const recovered = await this.recoverPrivateStore();
          if (recovered.view.status !== 'closed')
            throw new StoreError(recovered.view.code ?? 'CHECKOUT_RECOVERY', recovered.view.detail);
        }
        const opened = await this.openPrivateStore();
        if (opened.status !== 'owned')
          throw new StoreError(opened.code ?? 'CHECKOUT_RECOVERY', opened.detail);
        review = this.checkoutReply(
          await this.storeRequest('reconcileCheckout', { checkoutChoice: choice }),
        );
        await this.connections.editors.capture();
        if (review.phase === 'complete') return await this.cleanupCheckout(review);
        if (review.phase === 'restoring-editors') return await this.restoreCheckoutEditors(review);
        if (review.phase === 'entering') return await this.continueCheckoutEntry(review);
        if (review.phase === 'exiting') return await this.continueCheckoutExit(review);
        if (choice === 'restore') return await this.exitCheckout(review);
        return {
          status: 'active',
          detail: 'Resumed the verified retained PR checkout. Its inspected commit is unchanged.',
          review,
        };
      } catch (error) {
        return this.checkoutFailure(error, review);
      }
    });
  }
  recoverPrivateStore(): Promise<StoreReply> {
    return this.storeRequest('recover');
  }
  inspectRepositoryOperation(operationId: string): Promise<StoreReply> {
    return this.storeRequest('inspectOperation', { operationId });
  }

  fencePullRequestOverview(): void {
    this.sourceAuthorized = false;
    this.overviewGeneration += 1;
    this.connections.github?.sessionChanged();
    this.draftWriter.fence();
    this.draftProtocol.invalidate();
    this.draftWriter.changed();
  }

  handleGitHubSessionChange(requestingFirstSession: boolean): boolean {
    // First-time consent adds a session before /user can establish an actor.
    // There is no old private identity to fence in that specific state.
    if (requestingFirstSession && !this.account && !this.storeLease) return false;
    this.fencePullRequestOverview();
    return true;
  }

  async readSavedPullRequest(
    baseRepositoryId: string,
    pullNumber: number,
  ): Promise<ReviewCandidate | undefined> {
    const reply = await this.storeRequest('readCandidate', {
      candidateKey: { baseRepositoryId, pullNumber },
    });
    return reply.candidate;
  }

  async inspectPullRequestSource(
    baseRepositoryId: string,
    pullNumber: number,
  ): Promise<SourceResult> {
    const generation = this.overviewGeneration;
    const prepared = await this.storeRequest(
      'prepareSource',
      { candidateKey: { baseRepositoryId, pullNumber } },
      generation,
    );
    const plan = prepared.sourcePlan;
    if (!plan) return { status: 'unavailable', detail: prepared.view.detail };
    for (const side of ['new', 'old'] as const) {
      const intent = await this.storeRequest(
        'prepareSourceFetch',
        { sourceId: plan.id, side },
        generation,
      );
      if (!intent.operation)
        return { status: 'unavailable', detail: intent.view.detail, sourceId: plan.id };
      const outcome = await this.storeRequest(
        'executeOperation',
        { operationId: intent.operation.id },
        generation,
      );
      if (outcome.operation?.outcome !== 'applied')
        return {
          status: 'unavailable',
          detail:
            outcome.operation?.phase === 'observed'
              ? 'Git transport failed or the fetched source does not match verified PR metadata. No new comparison was installed. Check configured Git HTTPS credentials / SSH access, refresh the PR overview and Retry. API sign-in does not configure Git transport.'
              : outcome.view.detail,
          sourceId: plan.id,
        };
    }
    return this.publishCommittedSource(plan.id, generation);
  }
  async publishCommittedSource(
    sourceId: string,
    generation = this.overviewGeneration,
  ): Promise<SourceResult> {
    const reply = await this.storeRequest('publishSource', { sourceId }, generation);
    return reply.source
      ? { status: 'ready', source: reply.source }
      : { status: 'unavailable', detail: reply.view.detail, sourceId };
  }
  async readCommittedSource(sourceId?: string): Promise<SourceResult> {
    const reply = await this.storeRequest('readSource', sourceId ? { sourceId } : {});
    return reply.source
      ? { status: 'ready', source: reply.source }
      : { status: 'unavailable', detail: reply.view.detail };
  }
  async readCommittedFile(
    sourceId: string,
    fileId: string,
    side: SourceSide,
  ): Promise<CommittedContent> {
    const reply = await this.storeRequest('readCommittedFile', { sourceId, fileId, side });
    return reply.content ?? { status: 'unavailable', detail: reply.view.detail };
  }
  async setFileReviewed(sourceId: string, fileId: string, reviewed: boolean): Promise<string[]> {
    const reply = await this.storeRequest('setReviewed', { sourceId, fileId, reviewed });
    if (!reply.reviewed) throw new StoreError(reply.view.code ?? 'MARK_FAILED', reply.view.detail);
    return reply.reviewed;
  }
  async readReviewedMarks(sourceId: string): Promise<string[]> {
    const reply = await this.storeRequest('readReviewed', { sourceId });
    if (!reply.reviewed)
      throw new StoreError(reply.view.code ?? 'MARK_UNAVAILABLE', reply.view.detail);
    return reply.reviewed;
  }
  async saveSourceNavigation(navigation: SourceNavigation): Promise<SourceNavigation> {
    const reply = await this.storeRequest('saveNavigation', {
      sourceId: navigation.anchor.sourceId,
      navigation,
    });
    if (!reply.navigation)
      throw new StoreError(reply.view.code ?? 'NAVIGATION_FAILED', reply.view.detail);
    return reply.navigation;
  }
  async validateSourceNavigation(navigation: SourceNavigation): Promise<SourceNavigation> {
    const reply = await this.storeRequest('validateNavigation', {
      sourceId: navigation.anchor.sourceId,
      navigation,
    });
    if (!reply.navigation)
      throw new StoreError(reply.view.code ?? 'RANGE_UNAVAILABLE', reply.view.detail);
    return reply.navigation;
  }
  async readSourceNavigation(): Promise<SourceNavigation | undefined> {
    return (await this.storeRequest('readNavigation')).navigation;
  }

  async createLocalDraft(target: SourceNavigation): Promise<LocalDraft> {
    const navigation = structuredClone(target);
    const reply = await this.storeRequest('createDraft', {
      sourceId: navigation.anchor.sourceId,
      navigation,
    });
    if (!reply.draftCommit)
      throw new StoreError(reply.view.code ?? 'DRAFT_UNAVAILABLE', reply.view.detail);
    const draft = await this.readLocalDraft(reply.draftCommit.draftId);
    if (!draft) throw new StoreError('DRAFT_UNAVAILABLE', 'The new draft could not be reopened.');
    return draft;
  }
  openDraftWriter(id: string) {
    return this.draftWriter.open(id);
  }
  readDraftWriter() {
    return this.draftWriter.read();
  }
  editDraftWriter(writerId: string, expectedEditRevision: number, body: string) {
    return this.draftWriter.edit(writerId, expectedEditRevision, body);
  }
  flushDraftWriter() {
    return this.draftWriter.flush();
  }
  closeDraftWriter(writerId: string) {
    return this.draftWriter.close(writerId);
  }
  discardDraftWriter(writerId: string) {
    return this.draftWriter.discard(writerId);
  }
  retryDraftWriter(writerId: string) {
    return this.draftWriter.retry(writerId);
  }
  onDraftWriterChange(listener: () => void) {
    return this.draftWriter.subscribe(listener);
  }
  attachDraftWriter(instanceId: string) {
    return this.draftProtocol.attach(instanceId);
  }
  detachDraftWriter(instanceId: string) {
    this.draftProtocol.detach(instanceId);
  }
  snapshotDraftWriter(instanceId: string, reset = false) {
    return this.draftProtocol.snapshot(instanceId, reset);
  }
  handleDraftWriterMessage(message: unknown) {
    return this.draftProtocol.handle(message);
  }
  async readLocalDraft(draftId: string): Promise<LocalDraft | undefined> {
    const reply = await this.storeRequest('readDraft', { draftId });
    if (reply.view.status !== 'owned')
      throw new StoreError(reply.view.code ?? 'DRAFT_UNAVAILABLE', reply.view.detail);
    return reply.draft;
  }
  async listLocalDrafts(sourceId: string): Promise<LocalDraft[]> {
    const reply = await this.storeRequest('listDrafts', { sourceId });
    if (!reply.drafts)
      throw new StoreError(reply.view.code ?? 'DRAFT_UNAVAILABLE', reply.view.detail);
    return reply.drafts;
  }
  async listReviewDrafts(sourceId: string): Promise<LocalDraft[]> {
    const reply = await this.storeRequest('listReviewDrafts', { sourceId });
    if (!reply.drafts)
      throw new StoreError(reply.view.code ?? 'DRAFT_UNAVAILABLE', reply.view.detail);
    return reply.drafts;
  }
  async saveLocalDraft(edit: DraftEdit): Promise<DraftCommit> {
    const change = structuredClone(edit);
    const reply = await this.storeRequest(
      'saveDraft',
      { draftEdit: change },
      undefined,
      change.requestId,
    );
    if (!reply.draftCommit)
      throw new StoreError(reply.view.code ?? 'DRAFT_SAVE_FAILED', reply.view.detail);
    return reply.draftCommit;
  }
  async discardLocalDraft(discard: DraftDiscard): Promise<DraftCommit> {
    const change = structuredClone(discard);
    const reply = await this.storeRequest(
      'discardDraft',
      { draftDiscard: change },
      undefined,
      change.requestId,
    );
    if (!reply.draftCommit)
      throw new StoreError(reply.view.code ?? 'DRAFT_DISCARD_FAILED', reply.view.detail);
    return reply.draftCommit;
  }

  async openPullRequestOverview(url: string): Promise<PullRequestOverview> {
    const generation = ++this.overviewGeneration;
    const github = this.connections.github;
    const repository = this.connections.repository;
    if (!github || !repository) {
      return { status: 'blocked', detail: 'This installation has no GitHub PR connection.' };
    }
    const host = this.connections.environment();
    if (
      [
        checkWorkspace(host),
        checkWorkspaceTrust(host),
        checkEmbeddedRuntime(host),
        checkPlatform(host),
      ].some((check) => check.status !== 'passed')
    ) {
      return {
        status: 'blocked',
        detail: 'Use a trusted supported local desktop workspace to register this PR.',
      };
    }
    let local;
    try {
      local = await repository.inspect(host.folders[0]!.path);
    } catch {
      return {
        status: 'local-required',
        detail:
          'Select an existing local Git repository root. Git could not inspect this folder safely. Check Git installation, folder access and safe.directory, then Retry. Nothing was cloned or switched.',
      };
    }
    if (generation !== this.overviewGeneration) return staleOverview();
    const resolved = await github.resolvePullRequest(url, local.remotes);
    if (generation !== this.overviewGeneration) return staleOverview();
    if (resolved.status !== 'ready') return resolved;
    if (this.account && this.account.userId !== resolved.account.userId) {
      return {
        status: 'blocked',
        detail:
          'The private store belongs to another GitHub account or local scope. Reconnect its original account or explicitly Release Private Store before selecting this account. Saved identity was retained.',
      };
    }
    if (this.storeLease && !this.account)
      return {
        status: 'blocked',
        detail:
          'This window owns the private store in its local scope. Explicitly Release Private Store, then Retry to open it for the verified GitHub account.',
      };
    const baseRemote = resolved.repositories.find(
      (item) => item.identity.id === resolved.pullRequest.base.repository.id,
    );
    const headRemote = resolved.repositories.find(
      (item) => item.identity.id === resolved.pullRequest.head.repository?.id,
    );
    const selected = baseRemote ?? headRemote;
    const relation = baseRemote ? ('base' as const) : headRemote ? ('head' as const) : undefined;
    if (!relation) {
      return {
        status: 'local-required',
        detail:
          "The selected local folder is not a verified copy of this pull request's base or head repository. Open an existing local copy; nothing was cloned or switched.",
      };
    }
    let current;
    try {
      current = await repository.inspect(host.folders[0]!.path);
    } catch {
      return {
        status: 'local-required',
        detail: 'The selected local repository became unavailable. Restore access and Retry.',
      };
    }
    if (!sameLocalRepository(local, current) || generation !== this.overviewGeneration)
      return staleOverview();
    const actor = { host: resolved.account.host, userId: resolved.account.userId };
    // Identity was verified by /user even if a pending Git operation prevents
    // ownership claim. Keep it for explicit original-scope recovery.
    this.account = actor;
    this.sourceAuthorized = true;
    const ownership = await this.storeRequest('open', { actor }, generation);
    if (ownership.view.status === 'owned') this.account = actor;
    if (generation !== this.overviewGeneration) return staleOverview();
    if (ownership.view.status !== 'owned')
      return { status: 'blocked', detail: ownership.view.detail };
    const candidate: ReviewCandidate = {
      account: resolved.account,
      pullRequest: resolved.pullRequest,
      localRepository: {
        confirmation: 'user-confirmed',
        ...(resolved.unverifiedRemotes ? { unverifiedRemotes: true as const } : {}),
        facts: local,
        repositoryId: selected!.identity.id,
        relation,
        remote: selected!.remote,
      },
    };
    const registration = await this.storeRequest(
      'readRegistration',
      { registrationPath: local.worktree.path },
      generation,
    );
    if (generation !== this.overviewGeneration) return staleOverview();
    if (registration.view.status !== 'owned')
      return { status: 'blocked', detail: registration.view.detail };
    const retained = [baseRemote, headRemote].find(
      (item) => item && item.identity.id === registration.registration?.repositoryId,
    );
    if (retained) {
      candidate.localRepository.repositoryId = retained.identity.id;
      candidate.localRepository.relation = retained === baseRemote ? 'base' : 'head';
      candidate.localRepository.remote = retained.remote;
    }
    if (!registration.registration) {
      const confirmed = await this.connections.confirmLocalRepository?.(candidate);
      if (generation !== this.overviewGeneration) return staleOverview();
      if (!confirmed)
        return {
          status: 'local-required',
          detail:
            'First registration requires confirmation of this local copy and the verified GitHub repository ID. A remote name cannot prove clone origin. No candidate was saved; Retry to select and confirm the copy.',
        };
    }
    const saved = await this.storeRequest('saveCandidate', { candidate }, generation);
    if (generation !== this.overviewGeneration) return staleOverview();
    if (saved.view.status !== 'owned' || !saved.candidate) {
      return { status: 'blocked', detail: saved.view.detail };
    }
    this.sourceAuthorized = true;
    return { status: 'ready', ...saved.candidate };
  }

  private storeAction(action: StoreRequest['action']): Promise<StoreView> {
    return this.storeRequest(action).then((reply) => reply.view);
  }

  private storeRequest(
    action: StoreRequest['action'],
    fields: Pick<
      StoreRequest,
      | 'handoff'
      | 'targetWindowId'
      | 'refUpdate'
      | 'operationId'
      | 'candidate'
      | 'actor'
      | 'candidateKey'
      | 'registrationPath'
      | 'sourceId'
      | 'fileId'
      | 'side'
      | 'reviewed'
      | 'navigation'
      | 'editors'
      | 'checkoutId'
      | 'checkoutRevision'
      | 'checkoutChoice'
      | 'draftId'
      | 'draftEdit'
      | 'draftDiscard'
    > = {},
    overviewGeneration?: number,
    requestId: string = randomUUID(),
  ): Promise<StoreReply> {
    const privateAction =
      isSourceAction(action) || isCheckoutAction(action) || isDraftAction(action);
    const requestedGeneration = overviewGeneration ?? this.overviewGeneration;
    const work = this.storeQueue.then(async (): Promise<StoreReply> => {
      if (privateAction && !this.sourceAuthorized)
        return {
          view: {
            status: 'blocked',
            detail:
              'Reopen the PR overview to verify its original GitHub account before inspecting saved source or progress.',
          },
        };
      if (
        (overviewGeneration !== undefined || privateAction) &&
        requestedGeneration !== this.overviewGeneration
      )
        return {
          view: {
            status: 'blocked',
            detail: 'This overview request was superseded before storage dispatch.',
          },
        };
      const host = this.connections.environment();
      if (
        [
          checkWorkspace(host),
          checkWorkspaceTrust(host),
          checkEmbeddedRuntime(host),
          checkPlatform(host),
        ].some((check) => check.status !== 'passed')
      ) {
        return {
          view: {
            status: 'blocked',
            detail:
              'Use a trusted supported local desktop workspace before opening private storage.',
          },
        };
      }
      if (!this.connections.store)
        return {
          view: { status: 'blocked', detail: 'This installation has no shared-store connection.' },
        };
      try {
        if (
          action === 'open' &&
          (await this.connections.git(host.folders[0]!.path)).status !== 'passed'
        ) {
          return {
            view: {
              status: 'blocked',
              detail:
                'Open an already-cloned local Git repository before claiming the private store.',
            },
          };
        }
        if (overviewGeneration !== undefined && overviewGeneration !== this.overviewGeneration)
          return {
            view: {
              status: 'blocked',
              detail: 'This overview request was superseded before storage dispatch.',
            },
          };
        const request: StoreRequest = {
          protocol: 1,
          id: requestId,
          action,
          workspacePath: host.folders[0]!.path,
          ...fields,
          ...(this.storeLease ? { lease: this.storeLease } : {}),
        };
        const reply = await this.connections.store.request(request);
        if (
          !reply.lease ||
          !this.storeLease ||
          reply.lease.token !== this.storeLease.token ||
          reply.lease.revision >= this.storeLease.revision
        )
          this.storeLease = reply.lease;
        if (action === 'release' && reply.view.status === 'closed') this.account = undefined;
        if (privateAction && requestedGeneration !== this.overviewGeneration)
          return {
            view: {
              status: 'blocked',
              detail:
                'The account or selected review changed while this source request was running. Its durable receipt was retained; reopen the verified overview before continuing.',
            },
            // Fence presentation, not an already committed mutation outcome.
            // These receipts contain identity/revisions only, never draft text.
            ...((action === 'saveDraft' || action === 'discardDraft') && reply.draftCommit
              ? { draftCommit: reply.draftCommit }
              : {}),
          };
        return reply;
      } catch (error) {
        return {
          view: {
            status: 'recovery',
            code: error instanceof StoreError ? error.code : 'STORE_UNAVAILABLE',
            detail:
              error instanceof StoreError
                ? error.message
                : 'The private store is unavailable. Preserve its files and check recovery before writing.',
          },
        };
      }
    });
    this.storeQueue = work;
    return work;
  }

  async checkReadiness(): Promise<ReadinessReport> {
    const host = this.connections.environment();
    const checks = [
      checkWorkspace(host),
      checkWorkspaceTrust(host),
      checkEmbeddedRuntime(host),
      checkPlatform(host),
    ];
    const canRunLocalProbes = checks.every((check) => check.status === 'passed');

    if (canRunLocalProbes) {
      // checkWorkspace has established that exactly one local folder exists.
      const repositoryFolder = host.folders[0]!;
      const [gitResult, sqliteResult, nativeResult] = await Promise.allSettled([
        this.connections.git(repositoryFolder.path),
        this.connections.sqlite(),
        this.connections.native(),
      ]);

      checks.push(
        readProbeResult(gitResult, 'git', 'Git'),
        readProbeResult(sqliteResult, 'sqlite', 'Packaged SQLite worker'),
        readProbeResult(nativeResult, 'guard', 'Packaged ownership helper'),
      );
    } else {
      checks.push({
        id: 'probes',
        label: 'Local probes',
        status: 'blocked',
        detail: 'Git and SQLite probes were skipped until the host and workspace checks pass.',
      });
    }

    const ownership =
      this.connections.store && canRunLocalProbes ? await this.inspectPrivateStore() : undefined;
    checks.push({
      id: 'ownership',
      label: 'Review ownership',
      status: ownership?.status === 'owned' ? 'passed' : 'blocked',
      detail:
        ownership?.detail ??
        'Safe cross-window ownership is unavailable (#18). Starting a review and private-state writes remain disabled. Continue using the editor; ownership requires an extension update.',
    });

    return { checkedAt: new Date().toISOString(), checks, reviewAvailable: false };
  }
}

function checkWorkspace(host: HostEnvironment): Capability {
  const hasOneLocalFolder = host.folders.length === 1 && host.folders[0]?.scheme === 'file';
  const isSupported = host.desktop && !host.remote && hasOneLocalFolder;

  return {
    id: 'workspace',
    label: 'Workspace',
    status: isSupported ? 'passed' : 'blocked',
    detail: isSupported
      ? 'One local desktop folder.'
      : 'Open one already-cloned local desktop folder. Remote, virtual, browser and multi-root workspaces are unavailable; nothing was cloned.',
  };
}

function checkWorkspaceTrust(host: HostEnvironment): Capability {
  return {
    id: 'trust',
    label: 'Workspace Trust',
    status: host.trusted ? 'passed' : 'blocked',
    detail: host.trusted
      ? 'Trusted workspace.'
      : 'Use VS Code Workspace Trust to trust this folder before running probes.',
  };
}

function checkEmbeddedRuntime(host: HostEnvironment): Capability {
  const hasSupportedVsCode =
    host.vscode.startsWith('1.') && meetsMinimumVersion(host.vscode, [1, 141, 2]);
  const hasSupportedNode =
    host.node.startsWith('24.') && meetsMinimumVersion(host.node, [24, 15, 0]);

  return {
    id: 'runtime',
    label: 'Embedded runtime',
    status: hasSupportedVsCode && hasSupportedNode ? 'passed' : 'blocked',
    detail: `VS Code ${host.vscode}; Node ${host.node}; Electron ${host.electron ?? 'unavailable'}; Chromium ${host.chrome ?? 'unavailable'}. Requires VS Code 1.141.2+ and embedded Node 24.15+ within Node 24.`,
  };
}

function checkPlatform(host: HostEnvironment): Capability {
  const isMacArm = host.platform === 'darwin' && host.arch === 'arm64';
  const isWindowsOrLinuxX64 = ['win32', 'linux'].includes(host.platform) && host.arch === 'x64';

  return {
    id: 'platform',
    label: 'Platform target',
    status: isMacArm || isWindowsOrLinuxX64 ? 'passed' : 'blocked',
    detail: `${host.platform} ${host.arch}. Target matrix: Windows x64, Linux x64, macOS arm64. A passing probe alone does not establish platform support.`,
  };
}

function readProbeResult(
  result: PromiseSettledResult<Capability>,
  id: string,
  label: string,
): Capability {
  if (result.status === 'fulfilled') {
    return result.value;
  }

  return {
    id,
    label,
    status: 'blocked',
    detail: 'Probe failed. Check Git installation or reinstall the VSIX, then check again.',
  };
}

function meetsMinimumVersion(version: string, minimum: [number, number, number]): boolean {
  const versionParts = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
  if (!versionParts) {
    return false;
  }

  const major = Number(versionParts[1]);
  const minor = Number(versionParts[2]);
  const patch = Number(versionParts[3]);
  const [minimumMajor, minimumMinor, minimumPatch] = minimum;

  if (major !== minimumMajor) {
    return major > minimumMajor;
  }
  if (minor !== minimumMinor) {
    return minor > minimumMinor;
  }
  return patch >= minimumPatch;
}

function staleOverview(): PullRequestOverview {
  return {
    status: 'stale',
    detail: 'A newer account or pull request selection replaced this read. Its result was ignored.',
  };
}

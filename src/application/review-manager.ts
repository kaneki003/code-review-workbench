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
  confirmLocalRepository?(candidate: ReviewCandidate): Promise<boolean>;
}

// The owning manager coordinates actions independently of editor/view lifetime.
export class ReviewManager {
  private storeLease: StoreLease | undefined;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private overviewGeneration = 0;
  private account: Pick<GitHubAccount, 'host' | 'userId'> | undefined;
  private sourceAuthorized: boolean;
  constructor(private readonly connections: ReviewConnections) {
    this.account = connections.account;
    this.sourceAuthorized = Boolean(connections.account);
  }
  async dispose(): Promise<void> {
    try {
      if (this.storeLease) await this.releasePrivateStore();
    } finally {
      await this.connections.store?.dispose();
    }
  }

  openPrivateStore(handoff?: StoreHandoff): Promise<StoreView> {
    return this.storeRequest('open', handoff ? { handoff } : {}).then((reply) => reply.view);
  }
  releasePrivateStore(): Promise<StoreView> {
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
      | 'draftId'
      | 'draftEdit'
      | 'draftDiscard'
    > = {},
    overviewGeneration?: number,
    requestId: string = randomUUID(),
  ): Promise<StoreReply> {
    const privateAction = isSourceAction(action) || isDraftAction(action);
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

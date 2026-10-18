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
}

// The owning manager coordinates actions independently of editor/view lifetime.
export class ReviewManager {
  private storeLease: StoreLease | undefined;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private overviewGeneration = 0;
  private account: Pick<GitHubAccount, 'host' | 'userId'> | undefined;
  constructor(private readonly connections: ReviewConnections) {
    this.account = connections.account;
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
        facts: local,
        repositoryId: selected!.identity.id,
        relation,
        remote: selected!.remote,
      },
    };
    const saved = await this.storeRequest('saveCandidate', { candidate }, generation);
    if (generation !== this.overviewGeneration) return staleOverview();
    if (saved.view.status !== 'owned' || !saved.candidate) {
      return { status: 'blocked', detail: saved.view.detail };
    }
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
    > = {},
    overviewGeneration?: number,
  ): Promise<StoreReply> {
    const work = this.storeQueue.then(async (): Promise<StoreReply> => {
      if (overviewGeneration !== undefined && overviewGeneration !== this.overviewGeneration)
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
          id: randomUUID(),
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

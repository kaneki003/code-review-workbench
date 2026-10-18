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
  type ReviewCandidate,
} from './private-store';
import type {
  GitHubAccount,
  GitHubConnection,
  PullRequestRecord,
  PullRequestResolution,
} from '../connections/github';

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

export interface ReadinessConnections {
  environment(): HostEnvironment;
  git(folder: string): Promise<Capability>;
  sqlite(): Promise<Capability>;
  native(): Promise<Capability>;
  store?: StoreConnection;
  account?: Pick<GitHubAccount, 'host' | 'userId'>;
  github?: GitHubConnection;
  repository?: LocalRepositoryConnection;
}

export interface LocalRepositoryInspection {
  path: string;
  repositoryIds: string[];
  transport: 'https' | 'ssh';
}

export interface LocalRepositoryConnection {
  inspect(path: string): Promise<LocalRepositoryInspection>;
}

export type PullRequestOverview =
  | {
      status: 'ready';
      account: GitHubAccount;
      pullRequest: PullRequestRecord;
      localRepository: {
        path: string;
        repositoryId: string;
        relation: 'base' | 'head';
        transport: 'https' | 'ssh';
      };
    }
  | Exclude<PullRequestResolution, { status: 'ready' }>
  | { status: 'stale'; detail: string }
  | { status: 'local-required'; detail: string }
  | { status: 'blocked'; detail: string };

// This public action only inspects capabilities. It never acquires review ownership.
export class ReviewManager {
  private storeLease: StoreLease | undefined;
  private storeQueue: Promise<unknown> = Promise.resolve();
  private overviewGeneration = 0;
  constructor(private readonly connections: ReadinessConnections) {}
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
  }

  async openPullRequestOverview(url: string): Promise<PullRequestOverview> {
    const generation = ++this.overviewGeneration;
    const github = this.connections.github;
    const repository = this.connections.repository;
    if (!github || !repository) {
      return { status: 'blocked', detail: 'This installation has no GitHub PR connection.' };
    }
    const resolved = await github.resolvePullRequest(url);
    if (generation !== this.overviewGeneration) return staleOverview();
    if (resolved.status !== 'ready') return resolved;
    if (
      !this.connections.account ||
      this.connections.account.host !== resolved.account.host ||
      this.connections.account.userId !== resolved.account.userId
    ) {
      return {
        status: 'blocked',
        detail:
          'The verified GitHub account changed. Reopen this PR with that account; private review identity was not transferred.',
      };
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
    let local: LocalRepositoryInspection;
    try {
      local = await repository.inspect(host.folders[0]!.path);
    } catch {
      return {
        status: 'local-required',
        detail:
          'The selected folder has no verified GitHub base or fork remote. Open an existing local copy and configure its HTTPS helper or SSH transport, then retry. Nothing was cloned or switched.',
      };
    }
    if (generation !== this.overviewGeneration) return staleOverview();
    const relation = local.repositoryIds.includes(resolved.pullRequest.base.repository.id)
      ? ('base' as const)
      : local.repositoryIds.includes(resolved.pullRequest.head.repository.id)
        ? ('head' as const)
        : undefined;
    if (!relation) {
      return {
        status: 'local-required',
        detail:
          "The selected local folder is not a verified copy of this pull request's base or head repository. Open an existing local copy; nothing was cloned or switched.",
      };
    }
    const ownership = await this.openPrivateStore();
    if (generation !== this.overviewGeneration) return staleOverview();
    if (ownership.status !== 'owned') return { status: 'blocked', detail: ownership.detail };
    const repositoryId =
      relation === 'base'
        ? resolved.pullRequest.base.repository.id
        : resolved.pullRequest.head.repository.id;
    const candidate = candidateRecord(resolved.account, resolved.pullRequest, {
      path: local.path,
      repositoryId,
      relation,
      transport: local.transport,
    });
    const saved = await this.storeRequest('saveCandidate', { candidate });
    if (generation !== this.overviewGeneration) return staleOverview();
    if (saved.view.status !== 'owned' || !saved.candidate) {
      return { status: 'blocked', detail: saved.view.detail };
    }
    return {
      status: 'ready',
      account: resolved.account,
      pullRequest: resolved.pullRequest,
      localRepository: candidate.localRepository,
    };
  }

  private storeAction(action: StoreRequest['action']): Promise<StoreView> {
    return this.storeRequest(action).then((reply) => reply.view);
  }

  private storeRequest(
    action: StoreRequest['action'],
    fields: Pick<
      StoreRequest,
      'handoff' | 'targetWindowId' | 'refUpdate' | 'operationId' | 'candidate'
    > = {},
  ): Promise<StoreReply> {
    const work = this.storeQueue.then(async (): Promise<StoreReply> => {
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

function candidateRecord(
  account: GitHubAccount,
  pullRequest: PullRequestRecord,
  localRepository: ReviewCandidate['localRepository'],
): ReviewCandidate {
  return {
    account: { host: account.host, userId: account.userId },
    baseRepositoryId: pullRequest.base.repository.id,
    pullRequestId: pullRequest.id,
    pullNumber: pullRequest.number,
    localRepository,
    record: {
      title: pullRequest.title,
      body: pullRequest.body,
      state: pullRequest.state,
      draft: pullRequest.draft,
      url: pullRequest.url,
      author: pullRequest.author,
      baseFullName: pullRequest.base.repository.fullName,
      baseRef: pullRequest.base.ref,
      baseOid: pullRequest.base.oid,
      headRepositoryId: pullRequest.head.repository.id,
      headFullName: pullRequest.head.repository.fullName,
      headRef: pullRequest.head.ref,
      headOid: pullRequest.head.oid,
    },
  };
}

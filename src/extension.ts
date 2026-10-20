import * as vscode from 'vscode';
import {
  ReviewManager,
  type HostEnvironment,
  type ReviewConnections,
} from './application/review-manager';
import { probeGit } from './connections/git-readiness';
import { probeSqlite } from './connections/sqlite-readiness';
import { probeNativeGuard } from './connections/native-readiness';
import { createReadinessPanel } from './vscode/readiness-panel';
import { createStoreConnection } from './connections/shared-store';
import { resolveStoreConfiguration } from './connections/store-location';
import type { StoreConfiguration } from './application/private-store';
import { createGitHubConnection } from './connections/github';
import { createLocalRepositoryConnection } from './connections/local-repository';
import { createOverviewDocuments } from './vscode/overview-documents';
import type { ReviewCandidate } from './application/pull-request';
import { createCommittedReview } from './vscode/committed-review';
import type { CommittedSource } from './application/committed-source';
import { createDraftReview } from './vscode/draft-review';
import type { StorageDiagnostics } from './connections/storage-diagnostics';

let activeManager: ReviewManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  let requestingSession = false;
  const github = createGitHubConnection({
    getSession: async (forceNewSession) => {
      requestingSession = true;
      try {
        const session = await vscode.authentication.getSession(
          'github',
          ['repo'],
          forceNewSession ? { forceNewSession: true } : { createIfNone: true },
        );
        return session ? { accessToken: session.accessToken } : undefined;
      } finally {
        requestingSession = false;
      }
    },
  });
  // The installed-host seam uses isolated storage and controlled external reads.
  // Production and host tests still exercise the same public manager/actions.
  function createManager(
    configuration: StoreConfiguration,
    review: Pick<
      ReviewConnections,
      'github' | 'repository' | 'account' | 'confirmLocalRepository'
    > = {},
    diagnostics?: StorageDiagnostics,
  ) {
    return new ReviewManager({
      environment: readHostEnvironment,
      git: probeGit,
      sqlite: () =>
        probeSqlite(
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'readiness-worker.cjs').fsPath,
        ),
      native: () =>
        probeNativeGuard(
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'native-probe-worker.cjs').fsPath,
        ),
      store: createStoreConnection(
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'store-worker.cjs').fsPath,
        configuration,
        diagnostics,
      ),
      github,
      repository: createLocalRepositoryConnection(),
      confirmLocalRepository: async (candidate) =>
        (await vscode.window.showWarningMessage(
          'Register this selected local copy for the verified GitHub repository?',
          {
            modal: true,
            detail: `Local copy: ${candidate.localRepository.facts.worktree.path}\nGitHub repository ID: ${candidate.localRepository.repositoryId}\nPR: ${candidate.pullRequest.url}\n\nGit remote names can be reused and cannot prove clone origin. Confirm that this is the local copy you intend to associate with this immutable repository ID. This registers the copy only; source availability and Git authentication remain unverified.`,
          },
          'Register Local Copy',
        )) === 'Register Local Copy',
      ...(configuration.actor ? { account: configuration.actor } : {}),
      ...review,
    });
  }
  const location =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  const manager = createManager(resolveStoreConfiguration(location));
  activeManager = manager;
  const panel = createReadinessPanel(context.extensionUri, () => manager.checkReadiness());
  const documents = createOverviewDocuments();
  const committedReview = createCommittedReview(manager);
  const draftReview = createDraftReview(context, committedReview, manager);
  async function showCommitted(source: CommittedSource, owner = manager) {
    await committedReview.show(source, owner);
    await draftReview.showSource(source, owner);
  }
  let selection = 0;
  let lastUrl = '';
  let selectedCandidate: ReviewCandidate | undefined;
  let incompleteSourceId: string | undefined;
  context.subscriptions.push(
    panel,
    documents,
    committedReview,
    draftReview,
    vscode.commands.registerCommand('codeReviewWorkbench.checkReadiness', () => panel.show()),
    vscode.commands.registerCommand('codeReviewWorkbench.openPrivateStore', async () => {
      const view = await manager.openPrivateStore();
      void vscode.window.showInformationMessage(view.detail);
      return view;
    }),
    vscode.commands.registerCommand('codeReviewWorkbench.releasePrivateStore', async () => {
      const view = await manager.releasePrivateStore();
      if (view.status === 'closed') {
        selection += 1;
        selectedCandidate = undefined;
        committedReview.clear();
        draftReview.clear();
      }
      void vscode.window.showInformationMessage(view.detail);
      return view;
    }),
    vscode.commands.registerCommand('codeReviewWorkbench.recoverPrivateStore', async () => {
      const reply = await manager.recoverPrivateStore();
      void vscode.window.showInformationMessage(reply.view.detail);
      return reply.view;
    }),
    vscode.commands.registerCommand(
      'codeReviewWorkbench.openPullRequestOverview',
      async (providedUrl?: unknown) => {
        if (!(await draftReview.prepareChange())) return undefined;
        const selected = ++selection;
        selectedCandidate = undefined;
        committedReview.clear();
        draftReview.clear();
        manager.fencePullRequestOverview();
        const url =
          typeof providedUrl === 'string'
            ? providedUrl
            : await vscode.window.showInputBox({
                title: 'Open a verified PR overview',
                prompt: 'Paste a GitHub.com PR URL for this existing local repository',
                placeHolder: 'https://github.com/owner/repository/pull/123',
                value: lastUrl,
                ignoreFocusOut: true,
              });
        if (!url || selected !== selection) return undefined;
        lastUrl = url;
        const overview = await manager.openPullRequestOverview(url);
        if (selected !== selection || overview.status === 'stale') return overview;
        if (overview.status !== 'ready') {
          const delay =
            'retryAfter' in overview && overview.retryAfter
              ? ` Retry after ${Math.ceil(overview.retryAfter / 1000)} seconds.`
              : '';
          void vscode.window.showWarningMessage(overview.detail + delay, 'Retry').then((action) => {
            if (action === 'Retry' && selected === selection)
              void vscode.commands.executeCommand(
                'codeReviewWorkbench.openPullRequestOverview',
                url,
              );
          });
          return overview;
        }
        await documents.show(overview, () => selected === selection);
        if (selected === selection) selectedCandidate = overview;
        return overview;
      },
    ),
    vscode.commands.registerCommand('codeReviewWorkbench.inspectCommittedSource', async () => {
      if (!selectedCandidate)
        await vscode.commands.executeCommand('codeReviewWorkbench.openPullRequestOverview');
      const candidate = selectedCandidate;
      if (!candidate) return undefined;
      const selected = selection;
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Fetching and comparing committed PR source (no branch switch)',
        },
        () =>
          manager.inspectPullRequestSource(
            candidate.pullRequest.base.repository.id,
            candidate.pullRequest.number,
          ),
      );
      if (selected !== selection) return result;
      if (result.status !== 'ready') {
        incompleteSourceId = result.sourceId;
        void vscode.window.showWarningMessage(result.detail);
        return result;
      }
      incompleteSourceId = undefined;
      await showCommitted(result.source);
      await documents.show(candidate, () => selected === selection, result.source);
      return result;
    }),
    vscode.commands.registerCommand('codeReviewWorkbench.reconcileCommittedSource', async () => {
      const sourceId =
        incompleteSourceId ??
        (await vscode.window.showInputBox({
          title: 'Reconcile interrupted source publication',
          prompt: 'Source identity from the interrupted inspection (Git will not be repeated)',
        }));
      if (!sourceId) return;
      const selected = selection;
      const result = await manager.publishCommittedSource(sourceId);
      if (selected !== selection) return result;
      if (result.status === 'ready') {
        incompleteSourceId = undefined;
        await showCommitted(result.source);
        await documents.show(result.source.candidate, () => selected === selection, result.source);
      } else void vscode.window.showWarningMessage(result.detail);
      return result;
    }),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id !== 'github') return;
      if (manager.handleGitHubSessionChange(requestingSession)) {
        selectedCandidate = undefined;
        committedReview.clear();
        draftReview.clear();
        const changed = ++selection;
        void vscode.window
          .showWarningMessage(
            'The GitHub session changed. Saved PR identity remains with its original account. Retry to verify that account again.',
            'Retry',
          )
          .then((action) => {
            if (action === 'Retry' && changed === selection && lastUrl)
              void vscode.commands.executeCommand(
                'codeReviewWorkbench.openPullRequestOverview',
                lastUrl,
              );
          });
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      selectedCandidate = undefined;
      committedReview.clear();
      draftReview.clear();
      selection += 1;
      manager.fencePullRequestOverview();
    }),
  );
  return {
    createManager,
    showOverview: (candidate: ReviewCandidate, source?: CommittedSource) =>
      documents.show(candidate, () => true, source),
    showCommittedSource: (source: CommittedSource, owner: ReviewManager) =>
      showCommitted(source, owner),
    // A silent probe proves routing to the built-in provider without triggering
    // interactive login in an unattended host fixture.
    probeGitHubSignIn: async () => ({
      provider: 'github',
      scopes: ['repo'],
      sessionAvailable: Boolean(
        await vscode.authentication.getSession('github', ['repo'], { silent: true }),
      ),
    }),
  };
}

export async function deactivate() {
  await activeManager?.dispose();
  activeManager = undefined;
}

function readHostEnvironment(): HostEnvironment {
  return {
    vscode: vscode.version,
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
    trusted: vscode.workspace.isTrusted,
    remote: vscode.env.remoteName,
    folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      scheme: folder.uri.scheme,
      path: folder.uri.fsPath,
    })),
  };
}

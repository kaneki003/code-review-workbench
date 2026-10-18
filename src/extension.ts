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
  let selection = 0;
  let lastUrl = '';
  context.subscriptions.push(
    panel,
    documents,
    vscode.commands.registerCommand('codeReviewWorkbench.checkReadiness', () => panel.show()),
    vscode.commands.registerCommand('codeReviewWorkbench.openPrivateStore', async () => {
      const view = await manager.openPrivateStore();
      void vscode.window.showInformationMessage(view.detail);
      return view;
    }),
    vscode.commands.registerCommand('codeReviewWorkbench.releasePrivateStore', async () => {
      selection += 1;
      manager.fencePullRequestOverview();
      const view = await manager.releasePrivateStore();
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
        const selected = ++selection;
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
        return overview;
      },
    ),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id !== 'github') return;
      if (manager.handleGitHubSessionChange(requestingSession)) {
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
      selection += 1;
      manager.fencePullRequestOverview();
    }),
  );
  return {
    createManager,
    showOverview: (candidate: ReviewCandidate) => documents.show(candidate),
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

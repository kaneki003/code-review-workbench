import * as vscode from 'vscode';
import {
  ReviewManager,
  type HostEnvironment,
  type ReadinessConnections,
} from './application/review-manager';
import { probeGit } from './connections/git-readiness';
import { probeSqlite } from './connections/sqlite-readiness';
import { probeNativeGuard } from './connections/native-readiness';
import { createReadinessPanel } from './vscode/readiness-panel';
import { createStoreConnection } from './connections/shared-store';
import { resolveStoreConfiguration } from './connections/store-location';
import type { StoreConfiguration } from './application/private-store';
import { createOctokitGitHubConnection } from './connections/github';
import { createLocalRepositoryConnection } from './connections/local-repository';
import { createPullRequestOverviewMarkdown } from './vscode/pull-request-overview';

let activeManager: ReviewManager | undefined;
let activeAccountManager: ReviewManager | undefined;
let activeAccountId: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  const workerPath = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'readiness-worker.cjs',
  ).fsPath;
  // This host-only factory is also the installed-host integration seam. Tests
  // supply an isolated OS-user home; production resolves it from os.userInfo.
  function createManager(
    configuration: StoreConfiguration,
    reviewConnections: Pick<ReadinessConnections, 'account' | 'github' | 'repository'> = {},
  ) {
    return new ReviewManager({
      environment: readHostEnvironment,
      git: probeGit,
      sqlite: () => probeSqlite(workerPath),
      native: () =>
        probeNativeGuard(
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'native-probe-worker.cjs').fsPath,
        ),
      store: createStoreConnection(
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'store-worker.cjs').fsPath,
        configuration,
      ),
      ...reviewConnections,
    });
  }
  const location =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  const manager = createManager(resolveStoreConfiguration(location));
  activeManager = manager;
  const panel = createReadinessPanel(context.extensionUri, () => manager.checkReadiness());
  const github = createOctokitGitHubConnection(async () => {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    return session ? { accessToken: session.accessToken } : undefined;
  });
  context.subscriptions.push(
    panel,
    vscode.commands.registerCommand('codeReviewWorkbench.checkReadiness', () => panel.show()),
    vscode.commands.registerCommand('codeReviewWorkbench.openPrivateStore', async () => {
      const view = await manager.openPrivateStore();
      void vscode.window.showInformationMessage(view.detail);
      return view;
    }),
    vscode.commands.registerCommand('codeReviewWorkbench.releasePrivateStore', async () => {
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
      async (providedUrl?: string) => {
        const url =
          providedUrl ??
          (await vscode.window.showInputBox({
            title: 'Open a verified PR overview',
            prompt: 'Paste a complete GitHub.com pull request URL',
            placeHolder: 'https://github.com/owner/repository/pull/123',
            ignoreFocusOut: true,
          }));
        if (!url) return undefined;
        const initial = await github.resolvePullRequest(url);
        if (initial.status !== 'ready') {
          void vscode.window.showWarningMessage(initial.detail);
          return initial;
        }
        if (activeAccountId && activeAccountId !== initial.account.userId) {
          const blocked = {
            status: 'blocked' as const,
            detail:
              "A different GitHub account owns this window's private review state. Return to that account or release the private store explicitly; no review identity was transferred.",
          };
          void vscode.window.showWarningMessage(blocked.detail);
          return blocked;
        }
        if (!activeAccountManager) {
          const configuration = {
            ...resolveStoreConfiguration(location),
            actor: { host: initial.account.host, userId: initial.account.userId },
          };
          activeAccountManager = createManager(configuration, {
            account: configuration.actor,
            github,
            repository: createLocalRepositoryConnection(github),
          });
          activeAccountId = initial.account.userId;
        }
        const overview = await activeAccountManager.openPullRequestOverview(url);
        if (overview.status !== 'ready') {
          void vscode.window.showWarningMessage(overview.detail);
          return overview;
        }
        const document = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: createPullRequestOverviewMarkdown(overview),
        });
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('markdown.showPreview', document.uri);
        return overview;
      },
    ),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id !== 'github') return;
      activeAccountManager?.fencePullRequestOverview();
      if (activeAccountManager) {
        void vscode.window.showWarningMessage(
          'The GitHub session changed. Saved review identity remains with its original account; reconnect that account before retrying.',
        );
      }
    }),
  );
  return { createManager };
}

export async function deactivate() {
  await activeAccountManager?.dispose();
  activeAccountManager = undefined;
  activeAccountId = undefined;
  await activeManager?.dispose();
  activeManager = undefined;
}

function readHostEnvironment(): HostEnvironment {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

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
    folders: workspaceFolders.map((folder) => ({
      scheme: folder.uri.scheme,
      path: folder.uri.fsPath,
    })),
  };
}

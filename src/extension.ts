import * as vscode from 'vscode';
import { ReviewManager, type HostEnvironment } from './application/review-manager';
import { probeGit } from './connections/git-readiness';
import { probeSqlite } from './connections/sqlite-readiness';
import { probeNativeGuard } from './connections/native-readiness';
import { createReadinessPanel } from './vscode/readiness-panel';
import { createStoreConnection } from './connections/shared-store';
import { resolveStoreConfiguration } from './connections/store-location';
import type { StoreConfiguration } from './application/private-store';

let activeManager: ReviewManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  const workerPath = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'readiness-worker.cjs',
  ).fsPath;
  // This host-only factory is also the installed-host integration seam. Tests
  // supply an isolated OS-user home; production resolves it from os.userInfo.
  function createManager(configuration: StoreConfiguration) {
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
    });
  }
  const location =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  const manager = createManager(resolveStoreConfiguration(location));
  activeManager = manager;
  const panel = createReadinessPanel(context.extensionUri, () => manager.checkReadiness());
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
  );
  return { createManager };
}

export async function deactivate() {
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

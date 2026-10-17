import * as vscode from 'vscode';
import { ReviewManager, type HostEnvironment } from './application/review-manager';
import { probeGit } from './connections/git-readiness';
import { probeSqlite } from './connections/sqlite-readiness';
import { createReadinessPanel } from './vscode/readiness-panel';

export function activate(context: vscode.ExtensionContext) {
  const workerPath = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'readiness-worker.cjs',
  ).fsPath;
  const manager = new ReviewManager({
    environment: readHostEnvironment,
    git: probeGit,
    sqlite: () => probeSqlite(workerPath),
  });
  const panel = createReadinessPanel(context.extensionUri, () => manager.checkReadiness());
  context.subscriptions.push(
    panel,
    vscode.commands.registerCommand('codeReviewWorkbench.checkReadiness', () => panel.show()),
  );
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

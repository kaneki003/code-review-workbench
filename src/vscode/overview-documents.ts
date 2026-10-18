import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { normalizeCandidate, type ReviewCandidate } from '../application/pull-request';
import { createPullRequestOverviewMarkdown } from './pull-request-overview';
import type { CommittedSource } from '../application/committed-source';

export function createOverviewDocuments() {
  const content = new Map<string, string>();
  const previews = new WeakMap<vscode.Tab, string>();
  function preview(tab: vscode.Tab) {
    if (!(tab.input instanceof vscode.TabInputWebview)) return undefined;
    const uri =
      previews.get(tab) ??
      [...content.keys()].find(
        (value) => tab.label === `Preview ${vscode.Uri.parse(value).path.split('/').pop()}`,
      );
    const text = uri ? content.get(uri) : undefined;
    return uri && text !== undefined ? { uri, content: text } : undefined;
  }
  async function showPreview(uri: vscode.Uri, column?: number) {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
    const label = `Preview ${uri.path.split('/').pop()}`;
    const deadline = Date.now() + 5000;
    let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    while (!(tab?.input instanceof vscode.TabInputWebview) || tab.label !== label) {
      if (Date.now() > deadline)
        throw new Error(
          'The native Markdown preview did not become available. Retry opening the overview.',
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
      tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    }
    previews.set(tab, uri.toString());
    if (column !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn !== column)
      await vscode.commands.executeCommand('moveActiveEditor', {
        to: 'position',
        by: 'group',
        value: column,
      });
  }
  const provider = vscode.workspace.registerTextDocumentContentProvider('crw-overview', {
    provideTextDocumentContent: (uri) =>
      content.get(uri.toString()) ?? 'This overview is no longer available. Open the PR again.',
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) =>
    content.delete(document.uri.toString()),
  );
  return {
    read: (uri: string) => content.get(uri),
    retain: (uri: string, text: string) => {
      if (vscode.Uri.parse(uri).scheme === 'crw-overview') content.set(uri, text);
    },
    preview,
    showPreview,
    async show(
      input: ReviewCandidate,
      isCurrent: () => boolean = () => true,
      source?: CommittedSource,
      checkedOut = false,
    ) {
      const candidate = normalizeCandidate(input);
      const uri = vscode.Uri.from({
        scheme: 'crw-overview',
        path: `/pull-${candidate.pullRequest.number}-${randomUUID()}.md`,
      });
      content.set(uri.toString(), createPullRequestOverviewMarkdown(candidate, source, checkedOut));
      const document = await vscode.workspace.openTextDocument(uri);
      if (!isCurrent()) {
        content.delete(uri.toString());
        return undefined;
      }
      await vscode.languages.setTextDocumentLanguage(document, 'markdown');
      if (!isCurrent()) return undefined;
      await vscode.window.showTextDocument(document, { preview: false });
      if (!isCurrent()) return undefined;
      await showPreview(document.uri);
      return uri;
    },
    dispose() {
      provider.dispose();
      closed.dispose();
      content.clear();
    },
  };
}

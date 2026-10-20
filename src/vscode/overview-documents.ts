import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { normalizeCandidate, type ReviewCandidate } from '../application/pull-request';
import { createPullRequestOverviewMarkdown } from './pull-request-overview';
import type { CommittedSource } from '../application/committed-source';
import { activateEditorTab } from './editor-groups';

export function createOverviewDocuments() {
  const content = new Map<string, string | undefined>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const previews = new WeakMap<vscode.Tab, string>();
  function preview(tab: vscode.Tab) {
    if (!(tab.input instanceof vscode.TabInputWebview)) return undefined;
    const uri =
      previews.get(tab) ??
      [...content.keys()].find(
        (value) => tab.label === `Preview ${vscode.Uri.parse(value).path.split('/').pop()}`,
      );
    return uri ? { uri, content: content.get(uri) ?? '' } : undefined;
  }
  async function showPreview(uri: vscode.Uri, column?: number) {
    const existing = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs
        .filter((tab) => preview(tab)?.uri === uri.toString())
        .map((tab) => ({ tab, column: group.viewColumn })),
    )[0];
    if (existing) await activateEditorTab(existing.tab, existing.column);
    else await vscode.commands.executeCommand('markdown.showPreview', uri);
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
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) =>
      content.get(uri.toString()) ?? 'This overview is no longer available. Open the PR again.',
  });
  return {
    read: (uri: string) => content.get(uri),
    remember: (uri: string) => {
      if (vscode.Uri.parse(uri).scheme === 'crw-overview' && !content.has(uri))
        content.set(uri, undefined);
    },
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
      const identity = JSON.stringify([
        candidate.account.host,
        candidate.account.userId,
        candidate.pullRequest.base.repository.id,
        candidate.pullRequest.number,
        candidate.localRepository.facts.worktree,
      ]);
      const uri = vscode.Uri.from({
        scheme: 'crw-overview',
        path: `/pull-${candidate.pullRequest.number}-${createHash('sha256').update(identity).digest('hex')}.md`,
      });
      if (!isCurrent()) return undefined;
      content.set(uri.toString(), createPullRequestOverviewMarkdown(candidate, source, checkedOut));
      changed.fire(uri);
      const document = await vscode.workspace.openTextDocument(uri);
      if (!isCurrent()) return undefined;
      await vscode.languages.setTextDocumentLanguage(document, 'markdown');
      if (!isCurrent()) return undefined;
      const existing =
        vscode.window.tabGroups.all.find((group) =>
          group.tabs.some(
            (tab) =>
              tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === uri.toString(),
          ),
        ) ??
        vscode.window.tabGroups.all.find((group) =>
          group.tabs.some((tab) => preview(tab)?.uri === uri.toString()),
        );
      await vscode.window.showTextDocument(document, {
        preview: false,
        ...(existing ? { viewColumn: existing.viewColumn } : {}),
      });
      if (!isCurrent()) return undefined;
      await showPreview(document.uri);
      return uri;
    },
    async close() {
      const tabs = vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.filter(
          (tab) =>
            (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'crw-overview') ||
            !!preview(tab),
        ),
      );
      if (tabs.length && !(await vscode.window.tabGroups.close(tabs, true)))
        throw new Error('The PR overview tabs could not be closed. Retry Exit Review.');
      content.clear();
    },
    dispose() {
      provider.dispose();
      changed.dispose();
      content.clear();
    },
  };
}

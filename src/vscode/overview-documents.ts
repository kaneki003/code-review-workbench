import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { normalizeCandidate, type ReviewCandidate } from '../application/pull-request';
import { createPullRequestOverviewMarkdown } from './pull-request-overview';
import type { CommittedSource } from '../application/committed-source';

export function createOverviewDocuments() {
  const content = new Map<string, string>();
  const provider = vscode.workspace.registerTextDocumentContentProvider('crw-overview', {
    provideTextDocumentContent: (uri) =>
      content.get(uri.toString()) ?? 'This overview is no longer available. Open the PR again.',
  });
  const closed = vscode.workspace.onDidCloseTextDocument((document) =>
    content.delete(document.uri.toString()),
  );
  return {
    async show(
      input: ReviewCandidate,
      isCurrent: () => boolean = () => true,
      source?: CommittedSource,
    ) {
      const candidate = normalizeCandidate(input);
      const uri = vscode.Uri.from({
        scheme: 'crw-overview',
        path: `/pull-${candidate.pullRequest.number}-${randomUUID()}.md`,
      });
      content.set(uri.toString(), createPullRequestOverviewMarkdown(candidate, source));
      const document = await vscode.workspace.openTextDocument(uri);
      if (!isCurrent()) {
        content.delete(uri.toString());
        return undefined;
      }
      await vscode.languages.setTextDocumentLanguage(document, 'markdown');
      if (!isCurrent()) return undefined;
      await vscode.window.showTextDocument(document, { preview: false });
      if (!isCurrent()) return undefined;
      await vscode.commands.executeCommand('markdown.showPreview', document.uri);
      return uri;
    },
    dispose() {
      provider.dispose();
      closed.dispose();
      content.clear();
    },
  };
}

import * as vscode from 'vscode';
import type { ReviewManager } from '../../application/review-manager';
import type {
  CommittedFile,
  CommittedSource,
  SourceNavigation,
  SourceRange,
  SourceSide,
} from '../../domain/committed-source';
import { committedDocumentUri } from '../documents/committed-links';

interface FileTarget {
  sourceId: string;
  fileId: string;
}
function target(uri: vscode.Uri): (FileTarget & { side: SourceSide }) | undefined {
  const query = new URLSearchParams(uri.query);
  const fileId = query.get('file'),
    side = query.get('side');
  if (
    uri.scheme !== 'crw-source' ||
    !/^[a-f0-9-]{36}$/.test(uri.authority) ||
    !fileId ||
    !/^[a-f0-9]{64}$/.test(fileId) ||
    (side !== 'old' && side !== 'new')
  )
    return undefined;
  return { sourceId: uri.authority, fileId, side };
}
const startRange: SourceRange = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 };
function range(value: SourceRange) {
  return new vscode.Range(value.startLine, value.startCharacter, value.endLine, value.endCharacter);
}

// Native trees/documents inherit the user's theme, zoom and keyboard controls.
// They project manager-owned state; a file visit never writes a Reviewed mark.
export function createCommittedReview(initialManager: ReviewManager) {
  let manager = initialManager;
  let source: CommittedSource | undefined;
  let reviewed = new Set<string>();
  let presentation = 0;
  function assertPresentation(expected: number) {
    if (expected !== presentation)
      throw new Error('The selected review changed. Reopen the verified source before navigating.');
  }
  async function waitForEditor(
    uris: readonly vscode.Uri[],
    expectedPresentation: number,
  ): Promise<vscode.TextEditor> {
    const deadline = Date.now() + 5000;
    for (;;) {
      assertPresentation(expectedPresentation);
      const editor = vscode.window.activeTextEditor;
      if (editor && uris.some((uri) => editor.document.uri.toString() === uri.toString()))
        return editor;
      if (Date.now() > deadline)
        throw new Error(
          'The native diff could not focus the original source side. Its saved return target is retained.',
        );
      // Native command completion can precede the active-editor event sent
      // back to the extension host. Observe the side before selecting its range.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.TreeDataProvider<FileTarget> = {
    getParent: () => undefined,
    onDidChangeTreeData: changed.event,
    getChildren: () =>
      source?.files.map((file) => ({ sourceId: source!.id, fileId: file.id })) ?? [],
    getTreeItem(item) {
      const file =
        source?.id === item.sourceId
          ? source.files.find((file) => file.id === item.fileId)
          : undefined;
      if (!file) return new vscode.TreeItem('Source selection changed');
      const marked = reviewed.has(file.id);
      const row = new vscode.TreeItem(file.path);
      row.id = `${item.sourceId}/${item.fileId}`;
      row.description = `${file.status} · ${marked ? 'Reviewed' : 'Not reviewed'}`;
      row.tooltip = `${file.old && file.new && file.old.path !== file.new.path ? `${file.old.path} → ${file.new.path}\n` : ''}Original: ${file.old?.blob ?? 'absent'}\nNew: ${file.new?.blob ?? 'absent'}\n${marked ? 'Reviewed by you' : 'No human Reviewed mark'}`;
      row.iconPath = new vscode.ThemeIcon(marked ? 'check' : 'circle-outline');
      row.contextValue = marked ? 'crw-reviewed' : 'crw-unreviewed';
      row.accessibilityInformation = {
        label: `${file.path}, ${file.status}, ${marked ? 'Reviewed' : 'Not reviewed'}`,
      };
      row.command = {
        command: 'codeReviewWorkbench.openChangedDiff',
        title: 'Open committed diff',
        arguments: [item, 'files'],
      };
      return row;
    },
  };
  const tree = vscode.window.createTreeView('codeReviewWorkbench.files', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  tree.message = 'Open a verified PR overview, then Inspect Committed PR Diffs.';
  const documents = vscode.workspace.registerTextDocumentContentProvider('crw-source', {
    async provideTextDocumentContent(uri) {
      const selected = target(uri);
      if (!selected) throw vscode.FileSystemError.FileNotFound('Invalid committed-source target.');
      const snapshot = await load(selected.sourceId);
      const file = snapshot.files.find((file) => file.id === selected.fileId);
      if (
        !file ||
        vscode.Uri.parse(committedDocumentUri(snapshot, file, selected.side)).toString() !==
          uri.with({ fragment: '' }).toString()
      )
        throw vscode.FileSystemError.FileNotFound(
          'The source document label does not match its exact side, path and revision identity.',
        );
      const content = await manager.readCommittedFile(
        selected.sourceId,
        selected.fileId,
        selected.side,
      );
      if (content.status === 'available') return content.text;
      if (content.status === 'absent') return '';
      throw vscode.FileSystemError.FileNotFound(content.detail);
    },
  });
  async function load(id?: string): Promise<CommittedSource> {
    const result = await manager.readCommittedSource(id);
    if (result.status !== 'ready') throw new Error(result.detail);
    return result.source;
  }
  async function choose(
    input?: unknown,
  ): Promise<{ source: CommittedSource; file: CommittedFile } | undefined> {
    let selected: FileTarget | undefined;
    if (
      input &&
      typeof input === 'object' &&
      'sourceId' in input &&
      'fileId' in input &&
      typeof input.sourceId === 'string' &&
      typeof input.fileId === 'string'
    )
      selected = input as FileTarget;
    else
      selected = vscode.window.activeTextEditor
        ? target(vscode.window.activeTextEditor.document.uri)
        : undefined;
    const snapshot = await load(selected?.sourceId);
    if (!selected) {
      const chosen = await vscode.window.showQuickPick(
        snapshot.files.map((file) => ({ label: file.path, description: file.status, file })),
        { title: 'All changed files', matchOnDescription: true },
      );
      if (!chosen) return undefined;
      return { source: snapshot, file: chosen.file };
    }
    const file = snapshot.files.find((file) => file.id === selected!.fileId);
    if (!file) throw new Error('This file is unavailable in its original committed comparison.');
    return { source: snapshot, file };
  }
  async function rememberOrigin(focus: 'editor' | 'files') {
    const editor = vscode.window.activeTextEditor;
    const selected = editor && target(editor.document.uri);
    if (!editor || !selected) return;
    const content = await manager.readCommittedFile(
      selected.sourceId,
      selected.fileId,
      selected.side,
    );
    if (content.status !== 'available' && content.status !== 'absent')
      throw new Error(content.detail);
    const selection = editor.selection;
    return manager.saveSourceNavigation({
      anchor: {
        ...content.anchor,
        range: {
          startLine: selection.start.line,
          startCharacter: selection.start.character,
          endLine: selection.end.line,
          endCharacter: selection.end.character,
        },
      },
      control:
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff
          ? 'diff'
          : 'source',
      focus,
      column: editor.viewColumn ?? 1,
    });
  }
  async function showDiff(
    snapshot: CommittedSource,
    file: CommittedFile,
    navigation?: SourceNavigation,
    expectedPresentation = presentation,
  ) {
    const original = await manager.readCommittedFile(snapshot.id, file.id, 'old');
    const current = await manager.readCommittedFile(snapshot.id, file.id, 'new');
    for (const content of [original, current])
      if (content.status !== 'available' && content.status !== 'absent')
        throw new Error(content.detail);
    const oldUri = vscode.Uri.parse(committedDocumentUri(snapshot, file, 'old'));
    const newUri = vscode.Uri.parse(committedDocumentUri(snapshot, file, 'new'));
    assertPresentation(expectedPresentation);
    await vscode.commands.executeCommand(
      'vscode.diff',
      oldUri,
      newUri,
      `${file.old?.path ?? '(absent)'} → ${file.new?.path ?? '(deleted)'} · ${snapshot.mergeBase!.slice(0, 8)} ↔ ${snapshot.head.slice(0, 8)} · committed`,
      { preview: false, viewColumn: navigation?.column ?? vscode.ViewColumn.Active },
    );
    if (navigation) {
      assertPresentation(expectedPresentation);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      const desired = navigation.anchor.side === 'old' ? oldUri : newUri;
      const focused = await waitForEditor([oldUri, newUri], expectedPresentation);
      if (focused.document.uri.toString() !== desired.toString())
        await vscode.commands.executeCommand('diffEditor.switchSide');
      const editor = await waitForEditor([desired], expectedPresentation);
      const selection = range(navigation.anchor.range);
      editor.selection = new vscode.Selection(selection.start, selection.end);
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    return { original: oldUri, modified: newUri };
  }
  async function openDiff(input?: unknown, focus: 'editor' | 'files' = 'editor') {
    const expectedPresentation = presentation;
    const selected = await choose(input);
    if (!selected) return undefined;
    await rememberOrigin(focus);
    return showDiff(selected.source, selected.file, undefined, expectedPresentation);
  }
  async function openSource(input?: unknown, side?: SourceSide, requestedRange = startRange) {
    const expectedPresentation = presentation;
    const selected = await choose(input);
    if (!selected) return undefined;
    const selectedSide =
      side ??
      (
        await vscode.window.showQuickPick(
          [
            { label: 'New committed side', side: 'new' as const },
            { label: 'Original committed side', side: 'old' as const },
          ],
          { title: 'Open exact-revision source' },
        )
      )?.side;
    if (!selectedSide) return undefined;
    const content = await manager.readCommittedFile(
      selected.source.id,
      selected.file.id,
      selectedSide,
    );
    if (content.status !== 'available') throw new Error(content.detail);
    await manager.validateSourceNavigation({
      anchor: { ...content.anchor, range: requestedRange },
      control: 'source',
      focus: 'editor',
      column: 1,
    });
    await rememberOrigin('editor');
    const uri = vscode.Uri.parse(
      committedDocumentUri(selected.source, selected.file, selectedSide),
    );
    assertPresentation(expectedPresentation);
    await vscode.window.showTextDocument(uri, { preview: false, selection: range(requestedRange) });
    return uri;
  }
  async function returnToSource(originalTarget?: SourceNavigation) {
    const expectedPresentation = presentation;
    const saved = originalTarget ?? (await manager.readSourceNavigation());
    if (!saved) throw new Error('No committed source return target has been saved.');
    await manager.validateSourceNavigation(saved);
    const snapshot = await load(saved.anchor.sourceId);
    const file = snapshot.files.find((file) => file.id === saved.anchor.fileId)!;
    assertPresentation(expectedPresentation);
    if (saved.control === 'diff') await showDiff(snapshot, file, saved, expectedPresentation);
    else
      await vscode.window.showTextDocument(
        vscode.Uri.parse(committedDocumentUri(snapshot, file, saved.anchor.side)),
        { viewColumn: saved.column, preview: false, selection: range(saved.anchor.range) },
      );
    if (saved.focus === 'files') {
      if (source?.id === snapshot.id)
        await tree.reveal(
          { sourceId: snapshot.id, fileId: file.id },
          { focus: true, select: true },
        );
      else await vscode.commands.executeCommand('codeReviewWorkbench.files.focus');
    }
    return saved;
  }
  async function mark(input: unknown, value: boolean) {
    const expectedPresentation = presentation;
    const selected = await choose(input);
    if (!selected) return;
    const marks = await manager.setFileReviewed(selected.source.id, selected.file.id, value);
    assertPresentation(expectedPresentation);
    reviewed = new Set(marks);
    tree.description = `${source?.files.length ?? 0} files · ${reviewed.size} Reviewed`;
    changed.fire();
  }
  async function show(snapshot: CommittedSource, owner = manager, checkedOut = false) {
    const expectedPresentation = ++presentation;
    manager = owner;
    const marks = await owner.readReviewedMarks(snapshot.id);
    assertPresentation(expectedPresentation);
    source = snapshot;
    reviewed = new Set(marks);
    tree.message = `${checkedOut ? 'Active PR checkout. Working files and ordinary terminals use the owned review branch; native diffs retain committed source.' : 'No-switch reading. Working files and ordinary terminals remain on their earlier checkout.'} Inspected head ${snapshot.head.slice(0, 8)}; base tip ${snapshot.baseTip.slice(0, 8)}; merge base ${snapshot.mergeBase?.slice(0, 8) ?? 'unavailable'}. ${snapshot.limitations.join(' ')} Text blobs load on demand; binary, LFS and large-file limits appear when opened.`;
    tree.description = `${snapshot.files.length} files · ${reviewed.size} Reviewed`;
    changed.fire();
    await vscode.commands.executeCommand('codeReviewWorkbench.files.focus');
  }
  function clear() {
    presentation += 1;
    source = undefined;
    reviewed.clear();
    tree.message = 'Open a verified PR overview, then Inspect Committed PR Diffs.';
    tree.description = '';
    changed.fire();
  }
  const subscriptions = [documents, tree, changed];
  for (const [command, action] of [
    ['openChangedDiff', openDiff],
    ['openCommittedFile', openSource],
    ['returnToCommittedSource', returnToSource],
    ['markReviewed', (input?: unknown) => mark(input, true)],
    ['unmarkReviewed', (input?: unknown) => mark(input, false)],
  ] as const) {
    subscriptions.push(
      vscode.commands.registerCommand(
        `codeReviewWorkbench.${command}`,
        async (...args: unknown[]) => {
          try {
            return await (action as (...args: unknown[]) => Promise<unknown>)(...args);
          } catch (error) {
            void vscode.window.showWarningMessage(
              error instanceof Error ? error.message : 'Committed source is unavailable.',
            );
            return undefined;
          }
        },
      ),
    );
  }
  return {
    show,
    clear,
    openDiff,
    openSource,
    returnToSource,
    async captureDraftTarget() {
      const saved = await rememberOrigin('editor');
      if (!saved || !saved.anchor.blob)
        throw new Error(
          'Select an available original or new committed source range before writing private feedback.',
        );
      return saved;
    },
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

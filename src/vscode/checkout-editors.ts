import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import type {
  CheckoutEditors,
  EditorLayout,
  EditorSnapshot,
  EditorTab,
  EditorView,
} from '../application/checkout-review';
import { StoreError } from '../application/private-store';
import { validEditorSnapshot } from '../connections/checkout-journal';
import type { createOverviewDocuments } from './overview-documents';
import { restoreEditorScroll } from './editor-scroll';
type Overviews = Pick<
  ReturnType<typeof createOverviewDocuments>,
  'read' | 'retain' | 'preview' | 'showPreview'
>;

const failure = (detail: string): never => {
  throw new StoreError('EDITOR_RESTORATION', detail);
};
function uriKey(uri: vscode.Uri) {
  return uri.toString();
}
function describe(tab: vscode.Tab, overviews?: Overviews): EditorTab {
  const preview = overviews?.preview(tab);
  if (preview)
    return {
      kind: 'markdown-preview',
      ...preview,
      active: tab.isActive,
      preview: tab.isPreview,
      pinned: tab.isPinned,
      views: [],
    };
  const input = tab.input;
  let uri: vscode.Uri, original: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputText) uri = input.uri;
  else if (input instanceof vscode.TabInputTextDiff) {
    uri = input.modified;
    original = input.original;
  } else
    return failure(
      `The editor tab “${tab.label}” cannot be captured through the supported native text/diff API. Close it before switching; its contents were retained.`,
    );
  for (const resource of [uri, ...(original ? [original] : [])])
    if (
      !['file', 'crw-source', 'crw-overview'].includes(resource.scheme) ||
      (resource.scheme === 'file' && resource.authority)
    )
      failure(
        'An untitled, remote or unsupported editor cannot be safely restored. Save or close it before switching.',
      );
  const content = uri.scheme === 'crw-overview' ? overviews?.read(uriKey(uri)) : undefined;
  if (uri.scheme === 'crw-overview' && content === undefined)
    failure(
      'The original overview content is unavailable. Reopen it before capturing the workspace.',
    );
  return {
    kind: original ? 'diff' : 'text',
    uri: uriKey(uri),
    ...(original ? { original: uriKey(original) } : {}),
    ...(original ? { title: tab.label } : {}),
    active: tab.isActive,
    preview: tab.isPreview,
    pinned: tab.isPinned,
    views: [],
    ...(content !== undefined ? { content } : {}),
  };
}
function identity(tab: EditorTab) {
  return `${tab.kind}\0${tab.original ?? ''}\0${tab.uri}`;
}
function inventory(overviews?: Overviews) {
  return vscode.window.tabGroups.all.map((group) => ({
    column: group.viewColumn,
    active: group.isActive,
    tabs: group.tabs.map((tab) => describe(tab, overviews)),
  }));
}
function tabShape(groups: EditorSnapshot['groups']) {
  return JSON.stringify(
    groups.map((group) => ({
      column: group.column,
      tabs: group.tabs.map((tab) => ({
        id: identity(tab),
        title: tab.title ?? null,
        preview: tab.preview,
        pinned: tab.pinned,
      })),
    })),
  );
}
function sameLayout(expected: EditorLayout, actual: EditorLayout): boolean {
  const sameGroups = (left: EditorLayout['groups'], right: EditorLayout['groups']): boolean =>
    left.length === right.length &&
    left.every((group, index) => {
      const other = right[index]!;
      const totalLeft = left.reduce((sum, item) => sum + (item.size ?? 1), 0);
      const totalRight = right.reduce((sum, item) => sum + (item.size ?? 1), 0);
      return (
        Math.abs((group.size ?? 1) / totalLeft - (other.size ?? 1) / totalRight) < 0.02 &&
        (group.groups ? !!other.groups && sameGroups(group.groups, other.groups) : !other.groups)
      );
    });
  return expected.orientation === actual.orientation && sameGroups(expected.groups, actual.groups);
}
async function waitFor(action: () => boolean, detail: string) {
  const until = Date.now() + 5000;
  while (!action()) {
    if (Date.now() > until) failure(detail);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function focusGroup(column: number) {
  const ordinal = [
    'First',
    'Second',
    'Third',
    'Fourth',
    'Fifth',
    'Sixth',
    'Seventh',
    'Eighth',
    'Ninth',
  ][column - 1];
  if (!ordinal) return failure('The saved editor group is outside the supported native layout.');
  await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`);
  await waitFor(
    () => vscode.window.tabGroups.activeTabGroup.viewColumn === column,
    'The host could not focus the saved editor group.',
  );
}
async function open(tab: EditorTab, column: number, overviews?: Overviews) {
  if (tab.content !== undefined) overviews?.retain(tab.uri, tab.content);
  const existing = vscode.window.tabGroups.all.find((group) => group.viewColumn === column);
  if (
    existing?.tabs.some((candidate) => identity(describe(candidate, overviews)) === identity(tab))
  ) {
    await focusGroup(column);
    for (let attempt = 0; attempt <= existing.tabs.length; attempt += 1) {
      const current = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (current && identity(describe(current, overviews)) === identity(tab)) return;
      await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
      await waitFor(
        () => vscode.window.tabGroups.activeTabGroup.activeTab !== current,
        'The host could not activate an existing saved tab.',
      );
    }
    return failure('The saved editor tab disappeared during activation.');
  }
  const options = { viewColumn: column, preview: tab.preview, preserveFocus: false };
  if (tab.kind === 'markdown-preview') {
    if (!overviews) return failure('The original Markdown preview provider is unavailable.');
    await overviews.showPreview(vscode.Uri.parse(tab.uri), column);
  } else if (tab.kind === 'diff')
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(tab.original!),
      vscode.Uri.parse(tab.uri),
      tab.title,
      options,
    );
  else await vscode.window.showTextDocument(vscode.Uri.parse(tab.uri), options);
  await waitFor(() => {
    const group = vscode.window.tabGroups.activeTabGroup;
    return (
      group.viewColumn === column &&
      !!group.activeTab &&
      identity(describe(group.activeTab, overviews)) === identity(tab)
    );
  }, 'The native editor did not activate the saved tab. Its recovery snapshot is retained.');
}
function visibleEditors(tab: EditorTab, column: number): vscode.TextEditor[] {
  const input = vscode.window.tabGroups.all.find((group) => group.viewColumn === column)?.activeTab
    ?.input;
  const embedded =
    tab.kind === 'diff' &&
    input instanceof vscode.TabInputTextDiff &&
    input.modified.toString() === tab.uri &&
    input.original.toString() === tab.original;
  const candidates = vscode.window.visibleTextEditors.filter(
    (editor) =>
      [tab.uri, tab.original].includes(uriKey(editor.document.uri)) &&
      (editor.viewColumn === column || (editor.viewColumn === undefined && embedded)),
  );
  if (
    candidates.some(
      (editor) =>
        candidates.filter(
          (other) => other.document.uri.toString() === editor.document.uri.toString(),
        ).length > 1,
    )
  )
    failure(
      'Duplicate embedded diff editors cannot be associated with a saved group unambiguously. Close the duplicate before switching.',
    );
  return candidates;
}
function views(tab: EditorTab, column: number): EditorView[] {
  return visibleEditors(tab, column).map((editor) => ({
    uri: uriKey(editor.document.uri),
    topLine: editor.visibleRanges[0]?.start.line ?? 0,
    reversed: editor.selections.map((selection) => selection.isReversed),
    selections: editor.selections.map((selection) => ({
      startLine: selection.start.line,
      startCharacter: selection.start.character,
      endLine: selection.end.line,
      endCharacter: selection.end.character,
    })),
  }));
}

export function createCheckoutEditors(overviews?: Overviews): CheckoutEditors {
  function retain(snapshot: EditorSnapshot) {
    for (const group of snapshot.groups)
      for (const tab of group.tabs)
        if (tab.content !== undefined) overviews?.retain(tab.uri, tab.content);
  }
  function assertSaved() {
    if (
      vscode.workspace.textDocuments.some((document) => document.isDirty || document.isUntitled) ||
      vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty))
    )
      failure(
        'Unsaved or uncertain buffers prevent checkout/restoration. Save them normally, then Retry; no input was discarded.',
      );
  }
  async function save() {
    if (!(await vscode.workspace.saveAll(true)))
      failure(
        'A normal editor save was cancelled or failed. Keep no-switch reading and Retry after saving.',
      );
    assertSaved();
  }
  async function restoreActive(snapshot: EditorSnapshot) {
    const order = [
      ...snapshot.groups.filter((group) => !group.active),
      ...snapshot.groups.filter((group) => group.active),
    ];
    for (const group of order) {
      const tab = group.tabs.find((tab) => tab.active);
      if (tab) await open(tab, group.column, overviews);
      else if (group.active) await focusGroup(group.column);
    }
  }
  return {
    retain,
    assertSaved,
    async capture() {
      // Reject unsupported tabs before save dialogs or any editor rearrangement.
      inventory(overviews);
      await save();
      const groups = inventory(overviews);
      const shape = tabShape(groups);
      const workspace = await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath);
      const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
      if (!layout)
        return failure('The host could not capture its editor layout. Keep no-switch reading.');
      const snapshot: EditorSnapshot = { protocol: 1, workspace, layout, groups };
      try {
        for (const group of groups)
          for (const tab of group.tabs) {
            await open(tab, group.column, overviews);
            if (tab.kind !== 'markdown-preview')
              await waitFor(
                () =>
                  views(tab, group.column).length > 0 &&
                  (tab.kind !== 'diff' ||
                    [tab.uri, tab.original].includes(
                      vscode.window.activeTextEditor?.document.uri.toString(),
                    )),
                'The native editor did not expose the saved text/diff positions.',
              );
            tab.views = views(tab, group.column);
            const focus = vscode.window.activeTextEditor?.document.uri.toString();
            if (tab.kind === 'diff' && focus) tab.focus = focus;
            if (tab.kind !== 'markdown-preview' && !tab.views.length)
              failure('The native editor did not expose the tab positions for verified capture.');
          }
      } finally {
        await restoreActive(snapshot);
      }
      assertSaved();
      if (!validEditorSnapshot(snapshot))
        failure('Editor state exceeds the supported snapshot bounds. Keep no-switch reading.');
      if (shape !== tabShape(inventory(overviews)))
        failure(
          'Editor tabs or preview/pin states changed during capture. Retry without switching.',
        );
      return snapshot;
    },
    async restore(snapshot) {
      if (
        !validEditorSnapshot(snapshot) ||
        snapshot.workspace !== (await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath))
      )
        return failure('The editor snapshot belongs to an unavailable or different workspace.');
      await save();
      inventory(overviews);
      const tabs = vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
      if (tabs.length && !(await vscode.window.tabGroups.close(tabs, true)))
        return failure(
          'Closing current editor tabs was cancelled. Retry restoration; the prior snapshot is retained.',
        );
      assertSaved();
      await vscode.commands.executeCommand('vscode.setEditorLayout', snapshot.layout);
      for (const group of snapshot.groups) {
        for (const tab of [
          ...group.tabs.filter((tab) => !tab.preview),
          ...group.tabs.filter((tab) => tab.preview),
        ]) {
          await open(tab, group.column, overviews);
          if (tab.kind !== 'markdown-preview')
            await waitFor(
              () =>
                tab.views.every((saved) =>
                  visibleEditors(tab, group.column).some(
                    (editor) => uriKey(editor.document.uri) === saved.uri,
                  ),
                ),
              'A saved native source side did not become visible during restoration.',
            );
          if (tab.pinned) await vscode.commands.executeCommand('workbench.action.pinEditor');
          const index = group.tabs.indexOf(tab);
          await vscode.commands.executeCommand('moveActiveEditor', {
            to: 'position',
            by: 'tab',
            value: index + 1,
          });
          for (const saved of tab.views) {
            const editor = visibleEditors(tab, group.column).find(
              (editor) => uriKey(editor.document.uri) === saved.uri,
            );
            if (!editor) failure('A saved source side is unavailable during editor restoration.');
            editor!.selections = saved.selections.map((range, index) =>
              saved.reversed[index]
                ? new vscode.Selection(
                    range.endLine,
                    range.endCharacter,
                    range.startLine,
                    range.startCharacter,
                  )
                : new vscode.Selection(
                    range.startLine,
                    range.startCharacter,
                    range.endLine,
                    range.endCharacter,
                  ),
            );
            await restoreEditorScroll(editor!, saved.topLine);
          }
          if (
            tab.kind === 'diff' &&
            tab.focus &&
            vscode.window.activeTextEditor?.document.uri.toString() !== tab.focus
          ) {
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            await vscode.commands.executeCommand('diffEditor.switchSide');
            await waitFor(
              () => vscode.window.activeTextEditor?.document.uri.toString() === tab.focus,
              'The original native diff side did not regain focus.',
            );
          }
        }
      }
      await restoreActive(snapshot);
      await waitFor(
        () => tabShape(inventory(overviews)) === tabShape(snapshot.groups),
        'The host did not restore the saved tab groups/order. Retry editor restoration.',
      );
      assertSaved();
      const current = inventory(overviews);
      if (
        current.some(
          (group, index) =>
            group.active !== snapshot.groups[index]!.active ||
            group.tabs.some(
              (tab, tabIndex) => tab.active !== snapshot.groups[index]!.tabs[tabIndex]!.active,
            ),
        )
      )
        failure('The original active editor/group did not restore. Retry; Exit is not complete.');
      const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
      if (!layout || !sameLayout(snapshot.layout, layout))
        failure('The saved editor layout did not restore. Retry; Exit is not complete.');
      for (const group of snapshot.groups) {
        const active = group.tabs.find((tab) => tab.active);
        if (!active) continue;
        const actual = views(active, group.column);
        for (const view of active.views) {
          const restored = actual.find((item) => item.uri === view.uri);
          if (
            !restored ||
            restored.topLine !== view.topLine ||
            JSON.stringify(restored.selections) !== JSON.stringify(view.selections) ||
            JSON.stringify(restored.reversed) !== JSON.stringify(view.reversed)
          )
            failure('The saved editor selection did not restore. Retry; Exit is not complete.');
        }
      }
    },
  };
}

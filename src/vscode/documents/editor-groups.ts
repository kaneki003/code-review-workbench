import * as vscode from 'vscode';
import { StoreError } from '../../storage/contracts';

export async function waitForEditor(action: () => boolean, detail: string) {
  const until = Date.now() + 5000;
  while (!action()) {
    if (Date.now() > until) throw new StoreError('EDITOR_RESTORATION', detail);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function focusEditorGroup(column: number) {
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
  if (!ordinal)
    throw new StoreError(
      'EDITOR_RESTORATION',
      'The saved editor group is outside the supported native layout.',
    );
  await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`);
  await waitForEditor(
    () => vscode.window.tabGroups.activeTabGroup.viewColumn === column,
    'The host could not focus the saved editor group.',
  );
}

export async function activateEditorTab(tab: vscode.Tab, column: number) {
  await focusEditorGroup(column);
  const group = vscode.window.tabGroups.activeTabGroup;
  for (let attempt = 0; attempt <= group.tabs.length; attempt += 1) {
    const current = group.activeTab;
    if (current === tab) return;
    await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
    await waitForEditor(
      () => group.activeTab !== current,
      'The host could not activate an existing saved tab.',
    );
  }
  throw new StoreError('EDITOR_RESTORATION', 'The saved editor tab disappeared during activation.');
}

import * as vscode from 'vscode';
import { StoreError } from '../application/private-store';

export async function restoreEditorScroll(
  editor: Pick<vscode.TextEditor, 'document' | 'visibleRanges' | 'revealRange'>,
  topLine: number,
) {
  const until = Date.now() + 5000;
  while (!editor.visibleRanges.length && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 20));
  let observed = editor.visibleRanges[0]?.start.line;
  // Starting from the current displacement also avoids a no-op AtTop reveal
  // when the viewport is already just above the saved line.
  let requested = topLine + (observed === undefined ? 0 : topLine - observed);
  let viewportChangedAt = Date.now();
  let beforeReveal = observed;
  const reveal = () => {
    requested = Math.min(editor.document.lineCount - 1, Math.max(0, requested));
    beforeReveal = observed;
    editor.revealRange(
      new vscode.Range(requested, 0, requested, 0),
      vscode.TextEditorRevealType.AtTop,
    );
  };
  if (observed !== undefined && observed !== topLine) reveal();
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = editor.visibleRanges[0]?.start.line;
    if (current !== observed) {
      observed = current;
      viewportChangedAt = Date.now();
    }
    // Reveal is asynchronous and can animate. Do not accept a transient match
    // or calculate the next correction from a viewport that is still moving.
    if (Date.now() - viewportChangedAt < 200) continue;
    if (current === topLine) return;
    // No change cannot distinguish a no-op from a pending reveal. Keep waiting
    // rather than queueing a conflicting target that could arrive after success.
    if (current === beforeReveal) continue;
    if (current !== undefined) {
      // AtTop can include surrounding lines. Correct the last requested line,
      // retaining earlier corrections when host notifications arrive slowly.
      requested += topLine - current;
      reveal();
      viewportChangedAt = Date.now();
    }
  }
  throw new StoreError(
    'EDITOR_RESTORATION',
    'The saved editor scroll position did not restore. Retry; Exit is not complete.',
  );
}

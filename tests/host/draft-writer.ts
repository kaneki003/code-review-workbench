import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { dirname, join } from 'node:path';
import type { ReviewManager } from '../../src/application/review-manager';
import type { LocalDraft } from '../../src/application/local-draft';
import type { CommittedSource } from '../../src/application/committed-source';
import { DraftBrowser } from './draft-browser';

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

export async function exerciseDraftWriter(
  manager: ReviewManager,
  source: CommittedSource,
  target: { sourceId: string; fileId: string },
) {
  await vscode.commands.executeCommand('workbench.action.focusWindow');
  const uri = await vscode.commands.executeCommand<vscode.Uri>(
    'codeReviewWorkbench.openCommittedFile',
    target,
    'old',
    { startLine: 0, startCharacter: 0, endLine: 1, endCharacter: 5 },
  );
  await until(
    () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
    'Original source did not gain focus',
  );
  const draft = await vscode.commands.executeCommand<LocalDraft>(
    'codeReviewWorkbench.writeLocalDraft',
  );
  assert.ok(draft, 'Native range action creates a private draft');
  assert.equal(draft.target.anchor.side, 'old');
  assert.equal(draft.target.anchor.commit, source.mergeBase);
  const browser = await DraftBrowser.connect();
  const body = 'Private Unicode 🐈\n\n```ts\nunfinished **Markdown';
  const screenshots: string[] = [];
  try {
    await browser.insert(body);
    await until(
      () => manager.readDraftWriter()?.body === body,
      'Actual browser typing was not received by the host',
    );
    await browser.escape();
    await until(
      () => manager.readDraftWriter()?.status === 'failed',
      'The real failed commit did not retain the writer',
    );
    assert.equal(
      await browser.writer(
        `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
      ),
      body,
    );
    assert.equal(
      await browser.writer(`return doc.activeElement?.getAttribute('aria-label');`),
      'Private feedback',
    );
    assert.equal((await manager.readLocalDraft(draft.id))?.body, '');
    await browser.click('Retry');
    await until(
      () => manager.readDraftWriter()?.status === 'saved',
      'Retry did not commit actual input',
    );
    await browser.click('Preview');
    assert.ok(
      await browser.writer<boolean>(
        `return doc.querySelector('.draft-preview')?.textContent.includes('Private Unicode 🐈') ?? null;`,
      ),
    );
    await browser.click('Write');
    await browser.escape();
    await until(
      () =>
        manager.readDraftWriter() === undefined &&
        vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      'Close did not return to the original source',
    );
    assert.deepEqual(vscode.window.activeTextEditor!.selection, new vscode.Selection(0, 0, 1, 5));
    assert.equal((await manager.readLocalDraft(draft.id))?.body, body);
    await until(
      () =>
        browser.workbench<boolean>(`return document.body.innerText.includes('You · Local draft');`),
      'The saved native draft thread was not readable at its source',
    );

    const choosing = vscode.commands.executeCommand<LocalDraft>(
      'codeReviewWorkbench.showLocalDrafts',
    );
    await until(
      () =>
        browser.workbench<boolean>(
          `const picker=document.querySelector('.quick-input-widget');if(!picker||getComputedStyle(picker).display==='none'||!picker.getBoundingClientRect().height||!picker.innerText.includes('Private local drafts · original source targets')||!picker.querySelector('.monaco-list-row.focused')?.textContent.includes('worker.ts'))return false;picker.querySelector('input')?.focus();return true;`,
        ),
      'Native draft discovery did not show the original source',
    );
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const chosen = await choosing;
    assert.equal(
      chosen?.id,
      draft.id,
      `Native draft selection must reopen its record: ${await browser.workbench<string>(`return document.querySelector('.notifications-toasts')?.innerText ?? '';`)}`,
    );
    assert.equal(
      await browser.writer(
        `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
      ),
      body,
    );

    const pending = body + '\nrecreated pending input';
    await browser.insert('\nrecreated pending input');
    await until(
      () => manager.readDraftWriter()?.body === pending,
      'Pending input did not reach the manager',
    );
    await vscode.commands.executeCommand('codeReviewWorkbench.recreateDraftWriter');
    assert.equal(
      await browser.writer(
        `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
      ),
      pending,
    );
    await until(
      () => manager.readDraftWriter()?.status === 'saved',
      'Recreated writer did not finish saving',
    );
    assert.equal((await manager.listReviewDrafts(source.id)).length, 1);

    const moved = pending + '\nmoved pending input';
    await browser.insert('\nmoved pending input');
    await until(
      () => manager.readDraftWriter()?.body === moved,
      'Moving-view input was not received',
    );
    for (const destinationId of ['codeReviewWorkbench', 'codeReviewWorkbench-feedback']) {
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: ['codeReviewWorkbench.writer'],
        destinationId,
      });
      await vscode.commands.executeCommand('codeReviewWorkbench.writer.focus');
      assert.equal(
        await browser.writer(
          `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
        ),
        moved,
      );
      assert.equal(manager.readDraftWriter()?.id, draft.id);
    }

    await browser.insert('\nhidden pending input');
    const hidden = moved + '\nhidden pending input';
    await until(
      () => manager.readDraftWriter()?.body === hidden,
      'Hidden-view input was not received',
    );
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await until(
      () => manager.readDraftWriter()?.status === 'saved',
      'Hidden input did not save independently of the view',
    );
    assert.equal((await manager.readLocalDraft(draft.id))?.body, hidden);
    await vscode.commands.executeCommand('codeReviewWorkbench.openLocalDraft', draft.id);
    assert.equal(
      await browser.writer(
        `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
      ),
      hidden,
    );

    const accessibility = await browser.accessibility();
    assert.ok(
      accessibility.nodes.some(
        (node) => node.role?.value === 'textbox' && node.name?.value === 'Private feedback',
      ),
    );
    assert.ok(
      accessibility.nodes.some(
        (node) => node.role?.value === 'button' && node.name?.value === 'Close',
      ),
    );
    assert.ok(
      accessibility.nodes.some(
        (node) => node.role?.value === 'button' && node.name?.value === 'Discard draft',
      ),
    );
    // At the default panel height, keyboard focus must reveal footer controls.
    assert.ok(
      await browser.writer<boolean>(
        `const button=[...doc.querySelectorAll('button')].find(b=>b.textContent==='Close');button.focus();const bounds=button.getBoundingClientRect();return bounds.top>=0&&bounds.bottom<=doc.defaultView.innerHeight;`,
      ),
    );
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    for (const [theme, suffix] of [
      ['Default Dark Modern', 'dark'],
      ['Default Light Modern', 'light'],
      ['Default High Contrast', 'contrast'],
    ] as const) {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      await until(
        () =>
          browser.writer<boolean>(
            `return doc.body.classList.contains(${JSON.stringify(suffix === 'dark' ? 'vscode-dark' : suffix === 'light' ? 'vscode-light' : 'vscode-high-contrast')});`,
          ),
        `The writer did not adopt ${theme}`,
      );
      assert.equal(
        await browser.writer(
          `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
        ),
        hidden,
      );
      const image = `draft-writer-${suffix}.png`;
      await browser.screenshot(join(dirname(process.env.CRW_HOST_EVIDENCE!), image));
      screenshots.push(image);
    }
    await vscode.commands.executeCommand('workbench.action.zoomIn');
    assert.equal(
      await browser.writer(
        `return doc.querySelector('textarea[aria-label="Private feedback"]')?.value;`,
      ),
      hidden,
    );
    await vscode.commands.executeCommand('workbench.action.zoomOut');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await browser.narrow(420);
    await until(
      () => browser.writer<boolean>('return doc.documentElement.clientWidth <= 440;'),
      'Narrow workbench layout did not apply',
    );
    assert.ok(
      await browser.writer<boolean>(
        'return doc.documentElement.scrollWidth <= doc.documentElement.clientWidth;',
      ),
      'The writer must wrap without horizontal clipping',
    );
    await browser.screenshot(
      join(dirname(process.env.CRW_HOST_EVIDENCE!), 'draft-writer-narrow.png'),
    );
    screenshots.push('draft-writer-narrow.png');
    await browser.narrow();
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await browser.click('Discard draft');
    await until(() => manager.readDraftWriter() === undefined, 'Discard did not finish');
    assert.equal((await manager.readLocalDraft(draft.id))?.body, '');
    assert.ok((await manager.readLocalDraft(draft.id))!.deletionRevision > 0);
    assert.deepEqual(await manager.listReviewDrafts(source.id), []);
    return {
      screenshots,
      accessibilityNames: accessibility.nodes
        .map((node) => node.name?.value)
        .filter((name) => ['Private feedback', 'Close', 'Discard draft'].includes(name ?? '')),
      originalSide: draft.target.anchor.side,
      originalCommit: draft.target.anchor.commit,
    };
  } catch (error) {
    await browser
      .screenshot(join(dirname(process.env.CRW_HOST_EVIDENCE!), 'draft-writer-failure.png'))
      .catch(() => {});
    console.log(
      'Draft host failure state',
      JSON.stringify({
        writer: manager.readDraftWriter()
          ? { id: manager.readDraftWriter()!.id, status: manager.readDraftWriter()!.status }
          : null,
        page: await browser
          .writer(
            `return {hasInput:!!doc.querySelector('textarea[aria-label="Private feedback"]'),status:doc.querySelector('[role="status"]')?.textContent};`,
          )
          .catch((failure: Error) => failure.message),
        chrome: await browser
          .workbench(
            `return {panels:[...document.querySelectorAll('.pane-header')].map(e=>e.textContent),iframes:[...document.querySelectorAll('iframe')].map(e=>e.src)};`,
          )
          .catch((failure: Error) => failure.message),
      }),
    );
    throw error;
  } finally {
    await browser.narrow().catch(() => {});
    browser.dispose();
  }
}

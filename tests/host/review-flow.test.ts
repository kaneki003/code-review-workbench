import * as assert from 'node:assert/strict';
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';
import { test } from 'mocha';

import type { ReviewManager } from '../../src/application/review-manager';
import type { StoreConfiguration } from '../../src/storage/contracts';
import { execFileSync, fork } from 'node:child_process';

import type { ReviewConnections } from '../../src/application/review-manager';
import type { ReviewCandidate } from '../../src/domain/pull-request';
import type { CommittedSource } from '../../src/domain/committed-source';
import { createServer } from 'node:http';
import { exerciseDraftWriter, exerciseFailedDraftDiscard } from './draft-writer';
import type { StorageDiagnostics } from '../../src/storage/diagnostics';

import { type HostTestEvidence } from './support';

export function registerReviewFlowTest(
  evidence: HostTestEvidence,
  saveEvidence: () => Promise<void>,
) {
  test('installed committed documents preserve native diff sides, return range, readonly source and theme changes', async function () {
    // This case runs many real Git/SQLite/editor round trips. Windows CI
    // exceeded the earlier whole-case bounds; individual production
    // fetch, source-read and focus deadlines remain unchanged.
    this.timeout(process.platform === 'win32' ? 180000 : 60000);
    const extension = vscode.extensions.getExtension<{
      createManager(
        configuration: StoreConfiguration,
        review?: Pick<ReviewConnections, 'github' | 'confirmLocalRepository'>,
        diagnostics?: StorageDiagnostics,
      ): ReviewManager;
      showCommittedSource(source: CommittedSource, owner: ReviewManager): Promise<void>;
      showOverview(candidate: ReviewCandidate, source?: CommittedSource): Promise<vscode.Uri>;
    }>('kaneki003.code-review-workbench')!;
    const api = await extension.activate();
    const sandbox = await realpath(process.env.CRW_HOST_SANDBOX!);
    const location = await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    const home = join(sandbox, 'source-home');
    const remote = join(sandbox, 'source-remote.git');
    await mkdir(home, { mode: 0o700 });
    const git = (args: string[], input = '') =>
      execFileSync('git', ['-C', location, ...args], {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const original = git(
      ['hash-object', '-w', '--stdin'],
      'export const count = 1;\n// original range\n',
    );
    const modified = git(
      ['hash-object', '-w', '--stdin'],
      'export const count = 2;\n// new range\n',
    );
    const oldTree = git(
      ['mktree'],
      `100644 blob ${original}\tdeleted.py\n100644 blob ${original}\tworker.ts\n`,
    );
    const newTree = git(
      ['mktree'],
      `100644 blob ${modified}\tadded.py\n100644 blob ${modified}\tworker.ts\n`,
    );
    const commit = (tree: string, parent?: string) =>
      git([
        '-c',
        'commit.gpgSign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        'fixture',
      ]);
    const base = commit(oldTree),
      head = commit(newTree, base);
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '--git-dir',
        remote,
        'fetch',
        location,
        `${base}:refs/heads/main`,
        `${head}:refs/pull/20/head`,
      ],
      { stdio: 'pipe' },
    );
    execFileSync('git', ['--git-dir', remote, 'update-server-info']);
    const server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url!, 'http://fixture').pathname;
        if (!/^\/(?:info\/refs|HEAD|objects\/[a-f0-9/]+)$/.test(path))
          throw new Error('Not a Git object');
        response.end(await readFile(join(remote, path)));
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const rewrite = `url.http://127.0.0.1:${address.port}/.insteadOf`;
    git(['remote', 'add', 'source-fixture', 'https://github.com/acme/service.git']);
    git(['config', rewrite, 'https://github.com/acme/service.git']);
    const pullRequest = {
      id: '9001',
      number: 20,
      title: 'Exact committed source',
      body: '',
      state: 'open' as const,
      draft: false,
      url: 'https://github.com/acme/service/pull/20',
      author: null,
      base: { repository: { id: '3001', fullName: 'acme/service' }, ref: 'main', oid: base },
      head: { repository: { id: '4001', fullName: 'fork/service' }, ref: 'feature', oid: head },
    };
    const createSourceManager = (diagnostics: StorageDiagnostics) =>
      api.createManager(
        { osHome: home, candidateRoot: join(home, 'data'), location, windowId: 'source-host' },
        {
          confirmLocalRepository: async () => true,
          github: {
            sessionChanged() {},
            resolvePullRequest: async () => ({
              status: 'ready',
              account: { host: 'github.com', userId: '1001', login: 'reviewer' },
              pullRequest,
              repositories: [
                {
                  identity: pullRequest.base.repository,
                  remote: { owner: 'acme', repository: 'service', transport: 'https' },
                },
              ],
            }),
          },
        },
        diagnostics,
      );
    let manager = createSourceManager({ boundary: 'saveDraft.commit.before', mode: 'commit' });
    const diffConfiguration = vscode.workspace.getConfiguration('diffEditor');
    const previousInline = diffConfiguration.get('renderSideBySide');
    const previousAdaptive = diffConfiguration.get('useInlineViewWhenSpaceIsLimited');
    const themeConfiguration = vscode.workspace.getConfiguration('workbench');
    const previousTheme = themeConfiguration.get('colorTheme');
    try {
      // Original-side focus is a split-editor assertion. A narrow native
      // window otherwise collapses the two widgets into unified mode.
      await diffConfiguration.update('renderSideBySide', true, vscode.ConfigurationTarget.Global);
      await diffConfiguration.update(
        'useInlineViewWhenSpaceIsLimited',
        false,
        vscode.ConfigurationTarget.Global,
      );
      assert.equal((await manager.openPullRequestOverview(pullRequest.url)).status, 'ready');
      const result = await manager.inspectPullRequestSource('3001', 20);
      assert.equal(result.status, 'ready', JSON.stringify(result));
      const source = result.source;
      async function waitForActiveEditor(uri: vscode.Uri, action = 'source navigation') {
        const deadline = Date.now() + 5000;
        while (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) {
          if (Date.now() > deadline)
            throw new Error(
              `The native editor did not focus ${uri.path} during ${action}; active=${vscode.window.activeTextEditor?.document.uri.path}; windowFocused=${vscode.window.state.focused}; split=${vscode.workspace.getConfiguration('diffEditor', uri).get('renderSideBySide')}; adaptive=${vscode.workspace.getConfiguration('diffEditor', uri).get('useInlineViewWhenSpaceIsLimited')}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await api.showCommittedSource(source, manager);
      const target = {
        sourceId: source.id,
        fileId: source.files.find((file) => file.path === 'worker.ts')!.id,
      };
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('codeReviewWorkbench.returnToCommittedSource'));
      for (const command of [
        'enterPullRequestCheckout',
        'exitReview',
        'recoverPullRequestCheckout',
      ])
        assert.ok(commands.includes(`codeReviewWorkbench.${command}`));
      const opened = await vscode.commands.executeCommand<{
        original: vscode.Uri;
        modified: vscode.Uri;
      }>('codeReviewWorkbench.openChangedDiff', target);
      assert.ok(opened, 'Native diff must open');
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
      );
      const oldDocument = await vscode.workspace.openTextDocument(opened.original);
      const newDocument = await vscode.workspace.openTextDocument(opened.modified);
      assert.equal(oldDocument.getText(), 'export const count = 1;\n// original range\n');
      assert.equal(newDocument.getText(), 'export const count = 2;\n// new range\n');
      assert.match(opened.original.path, new RegExp(`Original-${base}`));
      assert.match(opened.modified.path, new RegExp(`New-${head}`));
      const editor = vscode.window.activeTextEditor!;
      editor.selection = new vscode.Selection(1, 0, 1, 5);
      await vscode.commands.executeCommand('codeReviewWorkbench.openCommittedFile', target, 'old', {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 6,
      });
      assert.equal(
        vscode.window.activeTextEditor!.document.uri.toString(),
        opened.original.toString(),
      );
      await vscode.commands.executeCommand('type', { text: 'must remain read only' });
      assert.equal(oldDocument.getText(), 'export const count = 1;\n// original range\n');
      await vscode.commands.executeCommand('codeReviewWorkbench.returnToCommittedSource');
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
      );
      assert.equal(
        vscode.window.activeTextEditor!.document.uri.toString(),
        opened.modified.toString(),
      );
      assert.deepEqual(vscode.window.activeTextEditor!.selection, new vscode.Selection(1, 0, 1, 5));
      // macOS CI can open the test window in the background. Native keyboard
      // actions need OS window focus as well as an active editor group.
      await vscode.commands.executeCommand('workbench.action.focusWindow');
      const focusDeadline = Date.now() + 5000;
      while (!vscode.window.state.focused) {
        if (Date.now() > focusDeadline)
          throw new Error('The native test window did not gain focus');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await vscode.commands.executeCommand('diffEditor.switchSide');
        const desired = attempt % 2 === 0 ? opened.original : opened.modified;
        await waitForActiveEditor(desired, `native side switch ${attempt + 1}`);
        assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), desired.toString());
      }
      assert.equal(
        vscode.window.activeTextEditor!.document.uri.toString(),
        opened.original.toString(),
      );
      vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 0, 1, 4);
      await vscode.commands.executeCommand('codeReviewWorkbench.openCommittedFile', target, 'new', {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
      });
      await vscode.commands.executeCommand('codeReviewWorkbench.returnToCommittedSource');
      assert.equal(
        vscode.window.activeTextEditor!.document.uri.toString(),
        opened.original.toString(),
      );
      assert.deepEqual(vscode.window.activeTextEditor!.selection, new vscode.Selection(1, 0, 1, 4));
      const overviewUri = await api.showOverview(source.candidate, source);
      const overview = await vscode.workspace.openTextDocument(overviewUri);
      assert.match(overview.getText(), /No-switch reading/);
      assert.match(overview.getText(), /3, complete Git comparison/);
      const link = [...overview.getText().matchAll(/\]\((crw-source:[^)]+)\)/g)]
        .map((match) => match[1]!)
        .find((value) => vscode.Uri.parse(value).path.endsWith('/worker.ts'))!;
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(link));
      assert.equal(
        vscode.window.activeTextEditor!.document.uri.toString(),
        opened.modified.toString(),
      );
      for (const [path, emptySide] of [
        ['added.py', 'original'],
        ['deleted.py', 'modified'],
      ] as const) {
        const absentTarget = {
          sourceId: source.id,
          fileId: source.files.find((file) => file.path === path)!.id,
        };
        const absentDiff = await vscode.commands.executeCommand<{
          original: vscode.Uri;
          modified: vscode.Uri;
        }>('codeReviewWorkbench.openChangedDiff', absentTarget);
        assert.ok(absentDiff);
        const emptyUri = absentDiff[emptySide];
        if (vscode.window.activeTextEditor?.document.uri.toString() !== emptyUri.toString())
          await vscode.commands.executeCommand('diffEditor.switchSide');
        await waitForActiveEditor(emptyUri);
        assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), emptyUri.toString());
        assert.equal(vscode.window.activeTextEditor!.document.getText(), '');
        const navigated = await vscode.commands.executeCommand(
          'codeReviewWorkbench.openChangedDiff',
          target,
        );
        assert.ok(navigated, 'An intentionally absent side must not block navigation');
        const returned = await vscode.commands.executeCommand<{
          anchor: { side: 'old' | 'new' };
        }>('codeReviewWorkbench.returnToCommittedSource');
        assert.ok(returned, 'Returning to an absent committed side must succeed');
        assert.equal(returned.anchor.side, emptySide === 'original' ? 'old' : 'new');
        await waitForActiveEditor(emptyUri, 'return to an absent committed side');
        assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), emptyUri.toString());
      }
      const misleading = opened.original.with({ path: `/New-${head}/incorrect.ts` });
      await assert.rejects(
        () => Promise.resolve(vscode.workspace.openTextDocument(misleading)),
        /label|identity|match/,
      );
      assert.deepEqual(await manager.readReviewedMarks(source.id), []);
      await vscode.commands.executeCommand('codeReviewWorkbench.markReviewed', target);
      assert.deepEqual(await manager.readReviewedMarks(source.id), [target.fileId]);
      await vscode.commands.executeCommand('codeReviewWorkbench.unmarkReviewed', target);
      assert.deepEqual(await manager.readReviewedMarks(source.id), []);
      await vscode.commands.executeCommand('codeReviewWorkbench.files.focus');
      await vscode.commands.executeCommand('list.focusFirst');
      await vscode.commands.executeCommand('list.select');
      async function waitForDiffPath(path: string) {
        const deadline = Date.now() + 5000;
        for (;;) {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          if (input instanceof vscode.TabInputTextDiff && input.modified.path.endsWith(path))
            return input;
          if (Date.now() > deadline)
            throw new Error(`Native keyboard navigation did not open ${path}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const keyboardOpened = await waitForDiffPath('/added.py');
      assert.ok(keyboardOpened instanceof vscode.TabInputTextDiff);
      assert.ok(
        keyboardOpened.modified.path.endsWith('/added.py'),
        'Keyboard selection opens the first changed file',
      );
      await vscode.commands.executeCommand('codeReviewWorkbench.openChangedDiff', target, 'files');
      await vscode.commands.executeCommand('codeReviewWorkbench.returnToCommittedSource');
      await vscode.commands.executeCommand('list.focusLast');
      await vscode.commands.executeCommand('list.select');
      const focusReturned = await waitForDiffPath('/worker.ts');
      assert.ok(focusReturned instanceof vscode.TabInputTextDiff);
      assert.ok(
        focusReturned.modified.path.endsWith('/worker.ts'),
        'Source return restores keyboard focus to the changed-file list',
      );
      await diffConfiguration.update('renderSideBySide', false, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('codeReviewWorkbench.openChangedDiff', target);
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
      );
      for (const theme of [
        'Default Light Modern',
        'Default Dark Modern',
        'Default High Contrast',
      ]) {
        await themeConfiguration.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('codeReviewWorkbench.files.focus');
        assert.equal(
          (await manager.readCommittedFile(source.id, target.fileId, 'new')).status,
          'available',
        );
      }
      await vscode.commands.executeCommand('workbench.action.zoomIn');
      await vscode.commands.executeCommand('workbench.action.zoomOut');
      evidence.drafts = await exerciseDraftWriter(manager, source, target);
      // Exercise prior-work preservation through the installed manager and
      // its actual native editor adapter, after the no-switch assertions above.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      git(['config', 'core.autocrlf', 'false']);
      await writeFile(join(location, '.gitattributes'), '* text=auto eol=lf\n');
      await writeFile(
        join(location, 'view.txt'),
        Array.from({ length: 400 }, (_, index) => `line ${index}: original editor position`).join(
          '\n',
        ),
      );
      git(['add', '.']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'original clean workspace',
      ]);
      const priorBranch = git(['symbolic-ref', 'HEAD']);
      const priorCommit = git(['rev-parse', 'HEAD']);
      const priorUri = vscode.Uri.file(join(location, 'view.txt'));
      const priorEditor = await vscode.window.showTextDocument(priorUri, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
      await priorEditor.edit((edit) =>
        edit.insert(new vscode.Position(0, 0), 'staged prior work\n'),
      );
      assert.equal(await priorEditor.document.save(), true);
      git(['add', 'view.txt']);
      const priorIndex = git(['ls-files', '--stage', '-z']);
      await priorEditor.edit((edit) =>
        edit.insert(new vscode.Position(0, 0), 'saved through normal host behavior\n'),
      );
      assert.equal(priorEditor.document.isDirty, true);
      const priorBytes = priorEditor.document.getText();
      await writeFile(join(location, 'prior-notes.txt'), 'new prior work 🐈\n');
      const longOverview = {
        ...source.candidate,
        pullRequest: {
          ...source.candidate.pullRequest,
          body: 'A detailed PR description remains ordinary review content.\n'.repeat(1200),
        },
      };
      const firstOverview = await api.showOverview(longOverview, source);
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      const repeatedOverview = await api.showOverview(longOverview, source);
      assert.equal(repeatedOverview?.toString(), firstOverview?.toString());
      await vscode.window.tabGroups.close(
        vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.filter(
            (tab) =>
              tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'crw-overview',
          ),
        ),
      );
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      const previewOnlyReopen = await api.showOverview(longOverview, source);
      assert.equal(previewOnlyReopen?.toString(), firstOverview?.toString());
      assert.equal(
        vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.filter(
            (tab) =>
              tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'crw-overview',
          ),
        ).length,
        1,
        'Repeated PR entry reuses the overview document',
      );
      assert.equal(
        vscode.window.tabGroups.all.flatMap((group) =>
          group.tabs.filter(
            (tab) =>
              tab.input instanceof vscode.TabInputWebview && tab.label.startsWith('Preview pull-'),
          ),
        ).length,
        1,
        'Repeated entry from another editor group reuses the overview preview',
      );
      const entered = await manager.enterPullRequestCheckout(source.id);
      assert.equal(
        entered.status,
        'active',
        JSON.stringify({
          entered,
          layout: await vscode.commands.executeCommand('vscode.getEditorLayout'),
        }),
      );
      assert.equal(git(['rev-parse', 'HEAD']), head);
      assert.equal(priorEditor.document.isDirty, false, 'Normal host saving precedes preservation');
      assert.equal(
        git(['status', '--porcelain=v1']),
        '',
        'Prior work is protected outside the PR checkout',
      );
      await vscode.window.tabGroups.close(
        vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]),
      );
      assert.equal(
        (await manager.readCheckoutReview())?.step,
        'active',
        'Closing tabs does not Exit',
      );
      await vscode.commands.executeCommand('vscode.open', opened.modified);
      await manager.dispose();
      manager = api.createManager({
        osHome: home,
        candidateRoot: join(home, 'data'),
        location,
        windowId: 'resumed-source-host',
        actor: { host: 'github.com', userId: '1001' },
      });
      assert.equal((await manager.openPrivateStore()).status, 'owned');
      await api.showCommittedSource(source, manager);
      const exited = await manager.exitPullRequestCheckout();
      assert.equal(exited.status, 'complete', JSON.stringify(exited));
      assert.equal(git(['symbolic-ref', 'HEAD']), priorBranch);
      assert.equal(git(['rev-parse', 'HEAD']), priorCommit);
      assert.equal(git(['ls-files', '--stage', '-z']), priorIndex, 'Original staging was restored');
      assert.equal(await readFile(priorUri.fsPath, 'utf8'), priorBytes);
      assert.equal(
        await readFile(join(location, 'prior-notes.txt'), 'utf8'),
        'new prior work 🐈\n',
      );
      assert.equal((await manager.releasePrivateStore()).status, 'closed');
      const retryingDiscard = createSourceManager({
        boundary: 'discardDraft.commit.before',
        mode: 'commit',
      });
      try {
        await retryingDiscard.openPullRequestOverview(pullRequest.url);
        await api.showCommittedSource(source, retryingDiscard);
        await exerciseFailedDraftDiscard(retryingDiscard, target);
      } finally {
        await retryingDiscard.dispose();
      }
    } finally {
      await diffConfiguration.update(
        'renderSideBySide',
        previousInline,
        vscode.ConfigurationTarget.Global,
      );
      await diffConfiguration.update(
        'useInlineViewWhenSpaceIsLimited',
        previousAdaptive,
        vscode.ConfigurationTarget.Global,
      );
      await themeConfiguration.update(
        'colorTheme',
        previousTheme,
        vscode.ConfigurationTarget.Global,
      );
      await manager.dispose();
      git(['config', '--unset', rewrite]);
      git(['remote', 'remove', 'source-fixture']);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

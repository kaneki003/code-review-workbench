import * as assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { suite, test, suiteSetup, suiteTeardown, teardown } from 'mocha';
import type { ReadinessReport } from '../../src/shared/readiness';
import type { ReviewManager } from '../../src/application/review-manager';
import type { StoreConfiguration } from '../../src/application/private-store';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import type { ReviewConnections } from '../../src/application/review-manager';
import type { ReviewCandidate } from '../../src/application/pull-request';
import type { CommittedSource } from '../../src/application/committed-source';
import { createServer } from 'node:http';

interface HostTestEvidence {
  status: string;
  tests: { name: string; result: string; failure?: string }[];
  host?: unknown;
  report?: ReadinessReport;
  extensionPath?: string;
}

async function fingerprintFiles(directory: string): Promise<Record<string, string>> {
  const fileHashes: Record<string, string> = {};

  async function visitDirectory(absolutePath: string, relativePrefix: string) {
    for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
      const relativePath = `${relativePrefix}${entry.name}`;
      const entryPath = join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        await visitDirectory(entryPath, `${relativePath}/`);
      } else {
        const contents = await readFile(entryPath);
        fileHashes[relativePath] = createHash('sha256').update(contents).digest('hex');
      }
    }
  }
  await visitDirectory(directory, '');
  return fileHashes;
}

function fixtureCommit(location: string) {
  const git = (args: string[], input = '') =>
    execFileSync('git', ['-C', location, '-c', 'commit.gpgSign=false', ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const tree = git(['mktree']);
  return git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit-tree',
    tree,
    '-m',
    'fixture',
  ]);
}

suite('Installed readiness VSIX', () => {
  const evidence: HostTestEvidence = { status: 'running', tests: [] };
  const saveEvidence = () =>
    writeFile(process.env.CRW_HOST_EVIDENCE!, JSON.stringify(evidence, null, 2));
  suiteSetup(async () => {
    evidence.host = {
      os: process.platform,
      architecture: process.arch,
      osRelease: (await import('node:os')).release(),
      vscode: vscode.version,
      runtime: process.versions,
    };
    await saveEvidence();
  });
  teardown(async function () {
    const current = this.currentTest!;
    evidence.tests.push({
      name: current.title,
      result: current.state ?? 'unknown',
      ...(current.err ? { failure: current.err.message } : {}),
    });
    await saveEvidence();
  });
  suiteTeardown(async () => {
    evidence.status = evidence.tests.some((result) => result.result !== 'passed')
      ? 'failed'
      : 'passed';
    await saveEvidence();
  });
  test('loads compiled UI and SQLite worker outside the source tree without changing the repository', async () => {
    const sandbox = process.env.CRW_HOST_SANDBOX!;
    const extension = vscode.extensions.getExtension('kaneki003.code-review-workbench');
    if (extension) {
      evidence.extensionPath = extension.extensionPath;
    }
    await saveEvidence();
    assert.ok(extension, 'VSIX must be installed');
    const installed = await realpath(extension.extensionPath);
    const installedRelative = relative(await realpath(join(sandbox, 'extensions')), installed);
    assert.ok(!isAbsolute(installedRelative) && !installedRelative.startsWith('..'));
    const sourceRelative = relative(await realpath(process.env.CRW_SOURCE_ROOT!), installed);
    assert.ok(isAbsolute(sourceRelative) || sourceRelative.startsWith('..'));
    const notices = await readFile(
      join(extension.extensionPath, 'dist', 'third-party-notices.txt'),
      'utf8',
    );
    assert.match(notices, /octokit@5\.0\.5/);
    assert.match(notices, /markdown-it@15\.0\.2/);
    const workspace = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const filesBeforeCheck = await fingerprintFiles(workspace);
    const report = await vscode.commands.executeCommand<ReadinessReport>(
      'codeReviewWorkbench.checkReadiness',
    );
    evidence.report = report;
    await saveEvidence();
    assert.ok(report);
    for (const id of [
      'workspace',
      'trust',
      'runtime',
      'platform',
      'git',
      'sqlite',
      'guard',
      'renderer',
    ]) {
      assert.equal(
        report.checks.find((check) => check.id === id)?.status,
        'passed',
        JSON.stringify(report, null, 2),
      );
    }
    assert.match(
      report.checks.find((check) => check.id === 'sqlite')!.detail,
      /In-memory parameterized transaction and rollback passed/,
    );
    assert.match(report.checks.find((check) => check.id === 'renderer')!.detail, /Chrome\//);
    assert.equal(report.reviewAvailable, false);
    assert.equal(report.checks.find((check) => check.id === 'ownership')?.status, 'blocked');
    assert.match(report.checks.find((check) => check.id === 'ownership')!.detail, /private store/);
    assert.deepEqual(
      await fingerprintFiles(workspace),
      filesBeforeCheck,
      'Every file, index and ref must remain unchanged',
    );
    console.log(JSON.stringify(report, null, 2));
  });
  test('installed public managers own one real store, commit, hand off and reopen it', async () => {
    const extension = vscode.extensions.getExtension<{
      createManager(configuration: StoreConfiguration): ReviewManager;
    }>('kaneki003.code-review-workbench')!;
    const api = await extension.activate();
    const sandbox = await realpath(process.env.CRW_HOST_SANDBOX!);
    const home = join(sandbox, 'store-home');
    await mkdir(home, { mode: 0o700 });
    const location = await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    const oid = fixtureCommit(location);
    const first = api.createManager({
      osHome: home,
      candidateRoot: join(home, 'data-A'),
      location,
      windowId: 'installed-first',
    });
    const second = api.createManager({
      osHome: home,
      candidateRoot: join(home, 'data-B'),
      location,
      windowId: 'installed-second',
    });
    try {
      const opened = await first.openPrivateStore();
      assert.equal(opened.status, 'owned', JSON.stringify(opened));
      assert.equal(opened.fence, 1);
      assert.equal(opened.process?.pid, process.pid);
      assert.equal(
        (await first.checkReadiness()).checks.find((check) => check.id === 'ownership')?.status,
        'passed',
      );
      const busy = await second.openPrivateStore();
      assert.equal(busy.status, 'busy');
      assert.equal(busy.ownerLocation, location);
      assert.deepEqual(Object.keys(busy).sort(), ['detail', 'ownerLocation', 'status']);
      const renewed = await first.renewOwnership();
      assert.equal(renewed.revision, opened.revision! + 1);
      const prepared = await first.prepareReferenceUpdate(
        'refs/code-review-workbench/installed',
        oid,
      );
      assert.equal(prepared.operation?.phase, 'prepared', JSON.stringify(prepared));
      const completed = await first.executeRepositoryOperation(prepared.operation!.id);
      assert.equal(completed.operation?.outcome, 'applied', JSON.stringify(completed));
      assert.equal(
        (await first.inspectRepositoryOperation(prepared.operation!.id)).operation?.phase,
        'observed',
      );
      const transfer = await first.offerStoreHandoff('installed-second');
      assert.equal(transfer.view.status, 'closed');
      const next = await second.openPrivateStore(transfer.handoff);
      assert.equal(next.status, 'owned', JSON.stringify(next));
      assert.equal(next.storeId, opened.storeId);
      assert.equal(next.root, opened.root);
      assert.equal(next.fence, 2);
      assert.equal((await first.renewOwnership()).status, 'recovery');
      assert.equal((await second.releasePrivateStore()).status, 'closed');
      assert.equal((await first.openPrivateStore()).fence, 3);
      assert.equal((await first.releasePrivateStore()).status, 'closed');
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(home, { recursive: true, force: true });
    }
    const commands = await vscode.commands.getCommands();
    assert.ok(commands.includes('codeReviewWorkbench.openPrivateStore'));
    assert.ok(commands.includes('codeReviewWorkbench.releasePrivateStore'));
    assert.ok(commands.includes('codeReviewWorkbench.recoverPrivateStore'));
    assert.ok(commands.includes('codeReviewWorkbench.openPullRequestOverview'));
    const unsupported = await vscode.commands.executeCommand<{ status: string; detail: string }>(
      'codeReviewWorkbench.openPullRequestOverview',
      'https://example.test/not-a-pull-request',
    );
    assert.equal(unsupported?.status, 'unsupported');
    assert.match(unsupported?.detail ?? '', /GitHub\.com pull request URL/);
  });
  test('installed overview uses the built-in auth provider and a read-only safe Markdown document', async () => {
    const extension = vscode.extensions.getExtension<{
      createManager(
        configuration: StoreConfiguration,
        review?: Pick<ReviewConnections, 'github' | 'repository' | 'confirmLocalRepository'>,
      ): ReviewManager;
      showOverview(candidate: ReviewCandidate): Promise<vscode.Uri>;
      probeGitHubSignIn(): Promise<{
        provider: string;
        scopes: string[];
        sessionAvailable: boolean;
      }>;
    }>('kaneki003.code-review-workbench')!;
    const api = await extension.activate();
    const provider = vscode.extensions.getExtension('vscode.github-authentication');
    assert.ok(provider, 'Built-in GitHub authentication must be installed');
    await provider.activate();
    assert.deepEqual(await api.probeGitHubSignIn(), {
      provider: 'github',
      scopes: ['repo'],
      sessionAvailable: false,
    });
    const sandbox = await realpath(process.env.CRW_HOST_SANDBOX!);
    const location = await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    const home = join(sandbox, 'overview-home');
    await mkdir(home, { mode: 0o700 });
    execFileSync('git', [
      '-C',
      location,
      'remote',
      'add',
      'overview-fixture',
      'https://github.com/acme/export-service.git',
    ]);
    const pullRequest = {
      id: '9001',
      number: 248,
      title: '![pixel](https://tracker.test/pixel) <script>title</script>',
      body: '**Real description**\n\n[close][action]\n\n[action]: command:workbench.action.closeWindow\n\n![pixel](https://tracker.test/pixel)\n\n<script>bad()</script>',
      state: 'open' as const,
      draft: false,
      url: 'https://github.com/acme/export-service/pull/248',
      author: { userId: '2001', login: 'author' },
      base: {
        repository: { id: '3001', fullName: 'acme/export-service' },
        ref: 'main',
        oid: 'a'.repeat(40),
      },
      head: { repository: null, ref: 'feature', oid: 'b'.repeat(40) },
    };
    const manager = api.createManager(
      { osHome: home, candidateRoot: join(home, 'data'), location, windowId: 'overview-host' },
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
                remote: { owner: 'acme', repository: 'export-service', transport: 'https' },
              },
            ],
          }),
        },
      },
    );
    try {
      const overview = await manager.openPullRequestOverview(pullRequest.url);
      assert.equal(overview.status, 'ready', JSON.stringify(overview));
      if (overview.status !== 'ready') throw new Error('No overview');
      const uri = await api.showOverview(overview);
      assert.equal(uri.scheme, 'crw-overview');
      const document = await vscode.workspace.openTextDocument(uri);
      const markdown = document.getText();
      assert.equal(document.isUntitled, false);
      assert.equal(document.languageId, 'markdown');
      assert.match(markdown, /<strong>Real description<\/strong>/);
      assert.match(markdown, /Fork unavailable/);
      assert.doesNotMatch(markdown, /command:|<script>|<img|<a\s|!\[pixel\]/);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('type', { text: 'should not be editable' });
      assert.equal(document.getText(), markdown);
      assert.equal((await manager.inspectPrivateStore()).status, 'owned');
      assert.equal((await manager.releasePrivateStore()).status, 'closed');
    } finally {
      await manager.dispose();
      execFileSync('git', ['-C', location, 'remote', 'remove', 'overview-fixture']);
      await rm(home, { recursive: true, force: true });
    }
  });
  test('installed committed documents preserve native diff sides, return range, readonly source and theme changes', async function () {
    // This case runs many real Git/SQLite/editor round trips. Windows CI
    // exceeded the runner's 25-second whole-case bound; individual production
    // fetch, source-read and focus deadlines remain unchanged.
    this.timeout(process.platform === 'win32' ? 90000 : 25000);
    const extension = vscode.extensions.getExtension<{
      createManager(
        configuration: StoreConfiguration,
        review?: Pick<ReviewConnections, 'github' | 'confirmLocalRepository'>,
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
    const manager = api.createManager(
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
    );
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
        await vscode.commands.executeCommand('codeReviewWorkbench.returnToCommittedSource');
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
      assert.equal((await manager.releasePrivateStore()).status, 'closed');
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
  test('installed recovery reconciles the actual worker after a separate owning host dies', async () => {
    const extension = vscode.extensions.getExtension<{
      createManager(configuration: StoreConfiguration): ReviewManager;
    }>('kaneki003.code-review-workbench')!;
    const api = await extension.activate();
    const sandbox = await realpath(process.env.CRW_HOST_SANDBOX!);
    const home = join(sandbox, 'recovery-home');
    await mkdir(home, { mode: 0o700 });
    const location = await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    const configuration: StoreConfiguration = {
      osHome: home,
      candidateRoot: join(home, 'data'),
      location,
      windowId: 'external-installed-owner',
    };
    const oid = fixtureCommit(location);
    const script = join(sandbox, 'installed-owner.cjs');
    await writeFile(
      script,
      `
      const {Worker}=require('node:worker_threads');
      const {randomUUID}=require('node:crypto');
      const configuration=JSON.parse(process.argv[3]);
      const worker=new Worker(process.argv[2],{workerData:configuration});
      let lease;
      async function request(action,fields={}) {
        const id=randomUUID();
        const reply=await new Promise((resolve,reject)=>{
          const listener=(message)=>{if(message.id===id){worker.off('message',listener);message.error?reject(Error(message.error.message)):resolve(message.reply)}};
          worker.on('message',listener);worker.once('error',reject);
          worker.postMessage({protocol:1,id,action,workspacePath:configuration.location,...fields,...(lease?{lease}:{})});
        });lease=reply.lease;return reply;
      }
      (async()=>{await request('open');const reply=await request('prepareRef',{refUpdate:{ref:'refs/code-review-workbench/installed-recovery',newOid:process.argv[4]}});process.send(reply)})().catch(error=>process.send({error:String(error)}));
    `,
    );
    const child = fork(
      script,
      [
        join(extension.extensionPath, 'dist', 'store-worker.cjs'),
        JSON.stringify(configuration),
        oid,
      ],
      {
        execPath: process.execPath,
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const manager = api.createManager({ ...configuration, windowId: 'installed-recovery' });
    try {
      const [prepared] = await once(child, 'message');
      assert.equal(prepared.operation?.phase, 'prepared', JSON.stringify(prepared));
      assert.equal((await manager.openPrivateStore()).status, 'busy');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      assert.equal((await manager.openPrivateStore()).status, 'recovery');
      const recovered = await manager.recoverPrivateStore();
      assert.equal(recovered.view.status, 'closed', JSON.stringify(recovered));
      assert.equal(recovered.operation?.outcome, 'not-applied');
      assert.equal((await manager.openPrivateStore()).fence, 2);
      assert.equal(
        (await manager.inspectRepositoryOperation(prepared.operation.id)).operation?.outcome,
        'not-applied',
      );
      assert.equal((await manager.releasePrivateStore()).status, 'closed');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await manager.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
  test('reinvoking during loading cancels the old attachment without a false installation failure', async () => {
    let tabSubscription: vscode.Disposable;
    let tabOpenTimeout: ReturnType<typeof setTimeout>;
    const readinessTabOpened = new Promise<void>((resolve, reject) => {
      tabOpenTimeout = setTimeout(() => reject(new Error('Readiness tab did not open')), 5000);
      tabSubscription = vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (event.opened.some((tab) => tab.label === 'Workbench readiness')) {
          resolve();
        }
      });
    });
    const firstCommand = vscode.commands.executeCommand<ReadinessReport | undefined>(
      'codeReviewWorkbench.checkReadiness',
    );
    try {
      await readinessTabOpened;
      const replacementCommand = vscode.commands.executeCommand<ReadinessReport>(
        'codeReviewWorkbench.checkReadiness',
      );
      assert.equal(
        await firstCommand,
        undefined,
        'Closing the old attachment is cancellation, not a package failure',
      );
      const report = await replacementCommand;
      assert.ok(report);
      assert.equal(report.checks.find((check) => check.id === 'renderer')?.status, 'passed');
    } finally {
      tabSubscription!.dispose();
      clearTimeout(tabOpenTimeout!);
    }
  });
});

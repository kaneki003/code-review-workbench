import * as assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { suite, test, suiteSetup, suiteTeardown, teardown } from 'mocha';
import type { ReadinessReport } from '../../src/shared/readiness';

async function manifest(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${key}/`);
      else
        result[key] = createHash('sha256')
          .update(await readFile(join(path, entry.name)))
          .digest('hex');
    }
  }
  await visit(directory, '');
  return result;
}

suite('Installed readiness VSIX', () => {
  const evidence: {
    status: string;
    tests: { name: string; result: string; failure?: string }[];
    host?: unknown;
    report?: ReadinessReport;
    extensionPath?: string;
  } = { status: 'running', tests: [] };
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
    if (extension) evidence.extensionPath = extension.extensionPath;
    await saveEvidence();
    assert.ok(extension, 'VSIX must be installed');
    const installed = await realpath(extension.extensionPath);
    const installedRelative = relative(await realpath(join(sandbox, 'extensions')), installed);
    assert.ok(!isAbsolute(installedRelative) && !installedRelative.startsWith('..'));
    const sourceRelative = relative(await realpath(process.env.CRW_SOURCE_ROOT!), installed);
    assert.ok(isAbsolute(sourceRelative) || sourceRelative.startsWith('..'));
    const workspace = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const before = await manifest(workspace);
    const report = await vscode.commands.executeCommand<ReadinessReport>(
      'codeReviewWorkbench.checkReadiness',
    );
    evidence.report = report;
    await saveEvidence();
    assert.ok(report);
    for (const id of ['workspace', 'trust', 'runtime', 'platform', 'git', 'sqlite', 'renderer']) {
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
    assert.equal(report.checks.find((check) => check.id === 'ownership')?.status, 'pending');
    assert.deepEqual(
      await manifest(workspace),
      before,
      'Every file, index and ref must remain unchanged',
    );
    console.log(JSON.stringify(report, null, 2));
  });
  test('reinvoking during loading cancels the old attachment without a false installation failure', async () => {
    let disposeListener: vscode.Disposable;
    let timer: ReturnType<typeof setTimeout>;
    const opened = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Readiness tab did not open')), 5000);
      disposeListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (event.opened.some((tab) => tab.label === 'Workbench readiness')) resolve();
      });
    });
    const older = vscode.commands.executeCommand<ReadinessReport | undefined>(
      'codeReviewWorkbench.checkReadiness',
    );
    try {
      await opened;
      const current = vscode.commands.executeCommand<ReadinessReport>(
        'codeReviewWorkbench.checkReadiness',
      );
      assert.equal(
        await older,
        undefined,
        'Closing the old attachment is cancellation, not a package failure',
      );
      const report = await current;
      assert.ok(report);
      assert.equal(report.checks.find((check) => check.id === 'renderer')?.status, 'passed');
    } finally {
      disposeListener!.dispose();
      clearTimeout(timer!);
    }
  });
});

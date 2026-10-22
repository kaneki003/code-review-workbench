import * as assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import * as vscode from 'vscode';
import { test } from 'mocha';
import type { ReadinessReport } from '../../src/protocol/readiness';

import { fingerprintFiles, type HostTestEvidence } from './support';

export function registerReadinessTest(
  evidence: HostTestEvidence,
  saveEvidence: () => Promise<void>,
) {
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
}

export function registerReadinessReentryTest(
  evidence: HostTestEvidence,
  saveEvidence: () => Promise<void>,
) {
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
}

import * as assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';
import type { ReadinessReport } from '../../src/shared/readiness';

async function manifest(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${key}/`);
      else result[key] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
    }
  }
  await visit(directory, '');
  return result;
}

suite('Installed readiness VSIX', () => {
  test('loads compiled UI and SQLite worker outside the source tree without changing the repository', async () => {
    const sandbox = process.env.CRW_HOST_SANDBOX!;
    const extension = vscode.extensions.getExtension('kaneki003.code-review-workbench');
    assert.ok(extension, 'VSIX must be installed');
    assert.ok(extension.extensionPath.startsWith(join(sandbox, 'extensions')));
    assert.ok(!extension.extensionPath.startsWith(process.env.CRW_SOURCE_ROOT!));
    const workspace = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const before = await manifest(workspace);
    const report = await vscode.commands.executeCommand<ReadinessReport>('codeReviewWorkbench.checkReadiness');
    assert.ok(report);
    for (const id of ['workspace', 'trust', 'runtime', 'platform', 'git', 'sqlite', 'renderer']) {
      assert.equal(report.checks.find(check => check.id === id)?.status, 'passed', JSON.stringify(report, null, 2));
    }
    assert.match(report.checks.find(check => check.id === 'sqlite')!.detail, /In-memory parameterized transaction and rollback passed/);
    assert.match(report.checks.find(check => check.id === 'renderer')!.detail, /Chrome\//);
    assert.equal(report.reviewAvailable, false);
    assert.equal(report.checks.find(check => check.id === 'ownership')?.status, 'pending');
    assert.deepEqual(await manifest(workspace), before, 'Every file, index and ref must remain unchanged');
    await writeFile(process.env.CRW_HOST_EVIDENCE!, JSON.stringify({
      os: process.platform, architecture: process.arch, osRelease: (await import('node:os')).release(),
      vscode: vscode.version, runtime: process.versions, extensionPath: extension.extensionPath, report,
    }, null, 2));
    console.log(JSON.stringify(report, null, 2));
  });
});

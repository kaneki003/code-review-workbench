import * as assert from 'node:assert/strict';
import { realpath, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';
import { test } from 'mocha';

import type { ReviewManager } from '../../src/application/review-manager';
import type { StoreConfiguration } from '../../src/storage/contracts';
import { execFileSync } from 'node:child_process';

import type { ReviewConnections } from '../../src/application/review-manager';
import type { ReviewCandidate } from '../../src/domain/pull-request';

import { type HostTestEvidence } from './support';

export function registerOverviewTest(
  evidence: HostTestEvidence,
  saveEvidence: () => Promise<void>,
) {
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
}

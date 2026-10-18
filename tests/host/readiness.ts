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
    assert.match(
      report.checks.find((check) => check.id === 'ownership')!.detail,
      /shared private store/,
    );
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

import * as assert from 'node:assert/strict';
import { realpath, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';
import { test } from 'mocha';

import type { ReviewManager } from '../../src/application/review-manager';
import type { StoreConfiguration } from '../../src/storage/contracts';
import { fork } from 'node:child_process';
import { once } from 'node:events';

import { fixtureCommit, type HostTestEvidence } from './support';

export function registerStorageTest(evidence: HostTestEvidence, saveEvidence: () => Promise<void>) {
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
}

export function registerStorageRecoveryTest(
  evidence: HostTestEvidence,
  saveEvidence: () => Promise<void>,
) {
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
}

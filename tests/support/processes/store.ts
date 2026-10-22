import { spawn } from 'node:child_process';
import { ReviewManager } from '../../../src/application/review-manager';
import { createStoreConnection } from '../../../src/storage/connection';
import type { StoreConfiguration } from '../../../src/storage/contracts';
import type { StorageDiagnostics } from '../../../src/storage/diagnostics';

const configuration = JSON.parse(process.argv[3]!) as StoreConfiguration;
const store = createStoreConnection(
  process.argv[2]!,
  configuration,
  process.argv[4] ? (JSON.parse(process.argv[4]) as StorageDiagnostics) : undefined,
);
let operationId: string | undefined;
const manager = new ReviewManager({
  environment: () => ({
    vscode: '1.142.0',
    node: process.versions.node,
    electron: undefined,
    chrome: undefined,
    platform: process.platform,
    arch: process.arch,
    desktop: true,
    trusted: true,
    remote: undefined,
    folders: [{ scheme: 'file', path: configuration.location }],
  }),
  git: async () => ({
    id: 'git',
    label: 'Git',
    status: 'passed',
    detail: 'Separate read-only probe',
  }),
  sqlite: async () => ({
    id: 'sqlite',
    label: 'SQLite',
    status: 'passed',
    detail: 'Separate read-only probe',
  }),
  native: async () => ({
    id: 'guard',
    label: 'Helper',
    status: 'passed',
    detail: 'Separate read-only probe',
  }),
  store,
});
process.on(
  'message',
  async (message: {
    id: number;
    action:
      | 'open'
      | 'release'
      | 'renew'
      | 'inspect'
      | 'reserve-child'
      | 'prepare-ref'
      | 'recover'
      | 'execute-ref';
    ref?: string;
    oid?: string;
  }) => {
    const actions = {
      open: () => manager.openPrivateStore(),
      release: () => manager.releasePrivateStore(),
      renew: () => manager.renewOwnership(),
      inspect: () => manager.inspectPrivateStore(),
      'prepare-ref': async () => {
        const reply = await manager.prepareReferenceUpdate(message.ref!, message.oid!);
        operationId = reply.operation?.id;
        return reply;
      },
      'execute-ref': () => manager.executeRepositoryOperation(operationId!),
      recover: () => manager.recoverPrivateStore(),
      'reserve-child': async () => {
        const receipt = await manager.recordRepositoryIntent();
        if (receipt.reservation) {
          // Test fixture only: deliberately leave a child outside production's
          // checkpoint. The saved barrier must survive this host dying.
          spawn(process.execPath, ['child.cjs'], {
            cwd: configuration.location,
            detached: true,
            stdio: 'ignore',
          }).unref();
        }
        return receipt.view;
      },
    };
    const result = await actions[message.action]();
    process.send!({ id: message.id, ...('view' in result ? result : { view: result }) });
  },
);
process.send!({ ready: true });

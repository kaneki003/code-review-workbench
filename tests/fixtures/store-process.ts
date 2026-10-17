import { spawn } from 'node:child_process';
import { ReviewManager } from '../../src/application/review-manager';
import { createStoreConnection } from '../../src/connections/shared-store';
import type { StoreConfiguration } from '../../src/application/private-store';

const configuration = JSON.parse(process.argv[3]!) as StoreConfiguration;
const store = createStoreConnection(process.argv[2]!, configuration);
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
    action: 'open' | 'release' | 'renew' | 'inspect' | 'reserve-child' | 'prepare-ref' | 'recover';
    ref?: string;
    oid?: string;
  }) => {
    const actions = {
      open: () => manager.openPrivateStore(),
      release: () => manager.releasePrivateStore(),
      renew: () => manager.renewOwnership(),
      inspect: () => manager.inspectPrivateStore(),
      'prepare-ref': async () =>
        (await manager.prepareReferenceUpdate(message.ref!, message.oid!)).view,
      recover: async () => (await manager.recoverPrivateStore()).view,
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
    process.send!({ id: message.id, view: await actions[message.action]() });
  },
);
process.send!({ ready: true });

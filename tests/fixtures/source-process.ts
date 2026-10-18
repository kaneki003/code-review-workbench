import { ReviewManager } from '../../src/application/review-manager';
import { createStoreConnection } from '../../src/connections/shared-store';
import { createLocalRepositoryConnection } from '../../src/connections/local-repository';
import type { StoreConfiguration } from '../../src/application/private-store';
import type { PullRequestRecord } from '../../src/application/pull-request';

const configuration = JSON.parse(process.argv[3]!) as StoreConfiguration;
const pullRequest = JSON.parse(process.argv[4]!) as PullRequestRecord;
const account = { host: 'github.com' as const, userId: '1001', login: 'reviewer' };
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
  git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: '' }),
  sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: '' }),
  native: async () => ({ id: 'guard', label: 'Guard', status: 'passed', detail: '' }),
  store: createStoreConnection(process.argv[2]!, configuration, {
    boundary: process.argv[6] || (process.argv[5] ? 'checkout.effect.after' : 'dispatch.after'),
    mode:
      process.argv[8] === 'native'
        ? 'native'
        : process.argv[8] === 'commit'
          ? 'commit'
          : process.argv[8] === 'crash'
            ? 'crash'
            : 'error',
    ...(process.argv[8] === 'native' ? { stage: 'directory-flush' as const } : {}),
  }),
  account,
  editors: {
    capture: async () => ({
      protocol: 1,
      workspace: configuration.location,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    }),
    assertSaved() {},
    restore: async () => {},
  },
  repository: createLocalRepositoryConnection(),
  confirmLocalRepository: async () => true,
  github: {
    sessionChanged() {},
    resolvePullRequest: async () => ({
      status: 'ready',
      account,
      pullRequest,
      repositories: [
        {
          identity: pullRequest.base.repository,
          remote: { owner: 'acme', repository: 'service', transport: 'https' },
        },
      ],
    }),
  },
});
process.on('message', () => {});
void (async () => {
  const checkoutSourceId = process.argv[5];
  if (checkoutSourceId) {
    await manager.openPrivateStore();
    if (process.argv[6]) {
      let result = await manager.enterPullRequestCheckout(checkoutSourceId);
      if (process.argv[7] === 'exit' && result.status === 'active')
        result = await manager.exitPullRequestCheckout();
      process.send!({ result });
      return;
    }
    const entry = await manager.prepareCleanCheckout(checkoutSourceId);
    const result = entry.operation
      ? await manager.executeRepositoryOperation(entry.operation.id)
      : entry;
    process.send!({ entry, result });
    return;
  }
  await manager.openPullRequestOverview(pullRequest.url);
  process.send!(
    await manager.inspectPullRequestSource(pullRequest.base.repository.id, pullRequest.number),
  );
})();

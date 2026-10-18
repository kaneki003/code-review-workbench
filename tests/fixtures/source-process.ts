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
    boundary: 'dispatch.after',
    mode: 'error',
  }),
  account,
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
  await manager.openPullRequestOverview(pullRequest.url);
  process.send!(
    await manager.inspectPullRequestSource(pullRequest.base.repository.id, pullRequest.number),
  );
})();

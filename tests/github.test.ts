import { expect, test, vi } from 'vitest';
import { createGitHubConnection } from '../src/connections/github';
import { ReviewManager, type HostEnvironment } from '../src/application/review-manager';
import type { StoreRequest } from '../src/application/private-store';
import { createPullRequestOverviewMarkdown } from '../src/vscode/pull-request-overview';

test('a supported PR URL resolves the authenticated actor and immutable base and head identities', async () => {
  const request = vi.fn(async (route: string) => {
    if (route === 'GET /user') {
      return { data: { id: 1001, login: 'reviewer' }, headers: {} };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
      return {
        data: {
          id: 9001,
          number: 248,
          title: 'Keep exports deterministic',
          body: "Preserve the author's **Markdown**.",
          state: 'open',
          draft: false,
          html_url: 'https://github.com/acme/export-service/pull/248',
          user: { id: 2001, login: 'author' },
          base: {
            ref: 'main',
            sha: 'a'.repeat(40),
            repo: { id: 3001, name: 'export-service', full_name: 'acme/export-service' },
          },
          head: {
            ref: 'fix/export-order',
            sha: 'b'.repeat(40),
            repo: { id: 4001, name: 'export-service', full_name: 'contributor/export-service' },
          },
        },
        headers: {},
      };
    }
    throw new Error(`Unexpected route: ${route}`);
  });
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret-never-returned' }),
    createClient: () => ({ request }),
    sleep: async () => undefined,
  });

  await expect(
    connection.resolvePullRequest('https://github.com/acme/export-service/pull/248'),
  ).resolves.toEqual({
    status: 'ready',
    account: { host: 'github.com', userId: '1001', login: 'reviewer' },
    pullRequest: {
      id: '9001',
      number: 248,
      title: 'Keep exports deterministic',
      body: "Preserve the author's **Markdown**.",
      state: 'open',
      draft: false,
      url: 'https://github.com/acme/export-service/pull/248',
      author: { userId: '2001', login: 'author' },
      base: {
        repository: { id: '3001', name: 'export-service', fullName: 'acme/export-service' },
        ref: 'main',
        oid: 'a'.repeat(40),
      },
      head: {
        repository: {
          id: '4001',
          name: 'export-service',
          fullName: 'contributor/export-service',
        },
        ref: 'fix/export-order',
        oid: 'b'.repeat(40),
      },
    },
  });
  expect(request).toHaveBeenNthCalledWith(1, 'GET /user');
  expect(request).toHaveBeenNthCalledWith(2, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: 'acme',
    repo: 'export-service',
    pull_number: 248,
  });
});

test.each([
  'https://gitlab.com/acme/repo/pull/1',
  'https://github.com/acme/repo/issues/1',
  'https://github.com/acme/repo/pull/0',
  'https://github.com/acme/repo/pull/1/files',
  'https://user@github.com/acme/repo/pull/1',
])('an unsupported destination is rejected before sign-in: %s', async (url) => {
  const getSession = vi.fn();
  const connection = createGitHubConnection({
    getSession,
    createClient: () => ({ request: vi.fn() }),
    sleep: async () => undefined,
  });

  await expect(connection.resolvePullRequest(url)).resolves.toMatchObject({
    status: 'unsupported',
  });
  expect(getSession).not.toHaveBeenCalled();
});

test('a throttled read retries within a bound and reports the retry delay if it remains blocked', async () => {
  const sleep = vi.fn(async () => undefined);
  const error = Object.assign(new Error('rate limited'), {
    status: 429,
    response: { headers: { 'retry-after': '2' } },
  });
  const request = vi.fn(async () => {
    throw error;
  });
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    createClient: () => ({ request }),
    sleep,
  });

  await expect(
    connection.resolvePullRequest('https://github.com/acme/repo/pull/1'),
  ).resolves.toMatchObject({ status: 'unavailable', retryAfter: 2000 });
  expect(request).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(2000);
});

test('organization SSO refusal is distinct from throttling and is not retried', async () => {
  const request = vi.fn(async () => {
    throw Object.assign(new Error('forbidden'), {
      status: 403,
      response: { headers: { 'x-github-sso': 'required' } },
    });
  });
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    createClient: () => ({ request }),
    sleep: vi.fn(),
  });

  await expect(
    connection.resolvePullRequest('https://github.com/acme/repo/pull/1'),
  ).resolves.toMatchObject({ status: 'unavailable', detail: expect.stringContaining('SSO') });
  expect(request).toHaveBeenCalledTimes(1);
});

const supportedHost: HostEnvironment = {
  vscode: '1.142.0',
  node: '24.21.0',
  electron: '43.7.7',
  chrome: '150.0.7871.250',
  platform: 'darwin',
  arch: 'arm64',
  desktop: true,
  trusted: true,
  remote: undefined,
  folders: [{ scheme: 'file', path: '/work/export-service' }],
};

const resolvedPullRequest = {
  status: 'ready' as const,
  account: { host: 'github.com' as const, userId: '1001', login: 'reviewer' },
  pullRequest: {
    id: '9001',
    number: 248,
    title: 'Keep exports deterministic',
    body: 'Author **description**.',
    state: 'open' as const,
    draft: false,
    url: 'https://github.com/acme/export-service/pull/248',
    author: { userId: '2001', login: 'author' },
    base: {
      repository: { id: '3001', name: 'export-service', fullName: 'acme/export-service' },
      ref: 'main',
      oid: 'a'.repeat(40),
    },
    head: {
      repository: {
        id: '4001',
        name: 'export-service',
        fullName: 'contributor/export-service',
      },
      ref: 'fix/export-order',
      oid: 'b'.repeat(40),
    },
  },
};

test('the manager retains a verified current local registration before returning an overview', async () => {
  const requests: StoreRequest[] = [];
  const manager = new ReviewManager({
    environment: () => supportedHost,
    git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: 'ready' }),
    sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: 'ready' }),
    native: async () => ({ id: 'guard', label: 'Guard', status: 'passed', detail: 'ready' }),
    account: { host: 'github.com', userId: '1001' },
    github: {
      resolvePullRequest: async () => resolvedPullRequest,
      resolveRepository: async () => undefined,
    },
    repository: {
      inspect: async () => ({
        path: '/work/export-service',
        repositoryIds: ['4001'],
        transport: 'ssh',
      }),
    },
    store: {
      async request(request) {
        requests.push(request);
        if (request.action === 'open') {
          return {
            view: { status: 'owned', detail: 'owned' },
            lease: {
              token: 'owner',
              storeId: 'store',
              incarnation: 'incarnation',
              fence: 1,
              revision: 1,
              scopeId: 'account-scope',
            },
          };
        }
        return {
          view: { status: 'owned', detail: 'saved' },
          lease: {
            token: 'owner',
            storeId: 'store',
            incarnation: 'incarnation',
            fence: 1,
            revision: 2,
            scopeId: 'account-scope',
          },
          candidate: request.candidate!,
        };
      },
      async dispose() {},
    },
  });

  await expect(
    manager.openPullRequestOverview('https://github.com/acme/export-service/pull/248'),
  ).resolves.toMatchObject({
    status: 'ready',
    account: resolvedPullRequest.account,
    pullRequest: resolvedPullRequest.pullRequest,
    localRepository: {
      path: '/work/export-service',
      repositoryId: '4001',
      relation: 'head',
      transport: 'ssh',
    },
  });
  expect(requests.map((request) => request.action)).toEqual(['open', 'saveCandidate']);
  expect(requests[1]?.candidate).toMatchObject({
    account: { host: 'github.com', userId: '1001' },
    baseRepositoryId: '3001',
    pullNumber: 248,
    localRepository: { path: '/work/export-service', repositoryId: '4001' },
  });
});

test('the manager rejects a late result after the selected target changes', async () => {
  let finishFirst!: (value: typeof resolvedPullRequest) => void;
  const first = new Promise<typeof resolvedPullRequest>((resolve) => (finishFirst = resolve));
  let calls = 0;
  const manager = new ReviewManager({
    environment: () => supportedHost,
    git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: 'ready' }),
    sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: 'ready' }),
    native: async () => ({ id: 'guard', label: 'Guard', status: 'passed', detail: 'ready' }),
    account: { host: 'github.com', userId: '1001' },
    github: {
      resolvePullRequest: async () => (++calls === 1 ? first : resolvedPullRequest),
      resolveRepository: async () => undefined,
    },
    repository: {
      inspect: async () => ({
        path: '/work/export-service',
        repositoryIds: ['3001'],
        transport: 'https',
      }),
    },
  });

  const stale = manager.openPullRequestOverview('https://github.com/acme/old/pull/1');
  const current = manager.openPullRequestOverview(
    'https://github.com/acme/export-service/pull/248',
  );
  finishFirst(resolvedPullRequest);

  await expect(stale).resolves.toMatchObject({ status: 'stale' });
  await expect(current).resolves.not.toMatchObject({ status: 'stale' });
});

test('a missing verified local copy keeps the PR input without opening private storage', async () => {
  const store = { request: vi.fn(), dispose: vi.fn() };
  const manager = new ReviewManager({
    environment: () => supportedHost,
    git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: 'ready' }),
    sqlite: async () => ({ id: 'sqlite', label: 'SQLite', status: 'passed', detail: 'ready' }),
    native: async () => ({ id: 'guard', label: 'Guard', status: 'passed', detail: 'ready' }),
    account: { host: 'github.com', userId: '1001' },
    github: {
      resolvePullRequest: async () => resolvedPullRequest,
      resolveRepository: async () => undefined,
    },
    repository: {
      inspect: async () => {
        throw new Error('No verified remote');
      },
    },
    store,
  });

  await expect(
    manager.openPullRequestOverview('https://github.com/acme/export-service/pull/248'),
  ).resolves.toMatchObject({
    status: 'local-required',
    detail: expect.stringContaining('existing local'),
  });
  expect(store.request).not.toHaveBeenCalled();
});

test('the overview labels its limits and neutralizes executable or remote author content', () => {
  const markdown = createPullRequestOverviewMarkdown({
    status: 'ready',
    account: resolvedPullRequest.account,
    pullRequest: {
      ...resolvedPullRequest.pullRequest,
      body: '<script>alert(1)</script>\n[run](command:workbench.action.closeWindow)\n![pixel](https://tracker.test/pixel)',
    },
    localRepository: {
      path: '/work/export-service',
      repositoryId: '4001',
      relation: 'head',
      transport: 'ssh',
    },
  });

  expect(markdown).toContain('# Keep exports deterministic');
  expect(markdown).toContain('Signed in as `reviewer`');
  expect(markdown).toContain('No branch was switched');
  expect(markdown).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(markdown).not.toContain('](command:');
  expect(markdown).not.toContain('\n![pixel]');
  expect(markdown).not.toContain('AI');
});

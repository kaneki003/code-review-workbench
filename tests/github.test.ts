import { expect, test } from 'vitest';
import { createGitHubConnection } from '../src/connections/github';

export function pullFixture() {
  return {
    id: 9001,
    number: 248,
    title: 'Deterministic exports',
    body: 'Author **description**.',
    state: 'open',
    merged: false,
    draft: false,
    html_url: 'https://github.com/acme/export-service/pull/248',
    user: { id: 2001, login: 'author' },
    base: {
      ref: 'main',
      sha: 'a'.repeat(40),
      repo: { id: 3001, full_name: 'acme/export-service' },
    },
    head: {
      ref: 'feature',
      sha: 'b'.repeat(40),
      repo: { id: 4001, full_name: 'fork/export-service' },
    },
  };
}

test('the real pinned client resolves a fork PR and local remote using one verified session', async () => {
  const requests: { url: string; headers: Headers }[] = [];
  let sessions = 0;
  const connection = createGitHubConnection({
    getSession: async () => {
      sessions += 1;
      return { accessToken: 'fixture-token' };
    },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      const data = url.endsWith('/user')
        ? { id: 1001, login: 'reviewer' }
        : url.endsWith('/pulls/248')
          ? pullFixture()
          : {
              id: url.includes('/fork/') ? 4001 : 3001,
              full_name: url.includes('/fork/') ? 'fork/export-service' : 'acme/export-service',
            };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await connection.resolvePullRequest(
    'https://github.com/acme/export-service/pull/248',
    [{ owner: 'fork', repository: 'export-service', transport: 'ssh' }],
  );
  expect(result).toMatchObject({
    status: 'ready',
    account: { host: 'github.com', userId: '1001', login: 'reviewer' },
    pullRequest: {
      id: '9001',
      number: 248,
      base: { repository: { id: '3001' } },
      head: { repository: { id: '4001' } },
    },
    repositories: [{ identity: { id: '4001' } }],
  });
  expect(sessions).toBe(1);
  expect(
    requests.every(({ headers }) => headers.get('x-github-api-version') === '2026-03-10'),
  ).toBe(true);
  expect(
    requests.every(({ headers }) => headers.get('accept') === 'application/vnd.github+json'),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('fixture-token');
});

test.each([
  ['https://gitlab.com/acme/repo/pull/1'],
  ['https://github.com/acme/repo/issues/1'],
  ['https://token@github.com/acme/repo/pull/1'],
  ['https://github.com/acme/repo/pull/0'],
  ['https://github.com/acme/repo/pull/1/files'],
])('unsupported destinations do not trigger sign-in: %s', async (url) => {
  const connection = createGitHubConnection({
    getSession: async () => {
      throw new Error('Sign-in must not run');
    },
  });
  await expect(connection.resolvePullRequest(url, [])).resolves.toMatchObject({
    status: 'unsupported',
  });
});

test.each([
  { status: 401, headers: {}, expected: 'reconnect' },
  { status: 403, headers: { 'x-github-sso': 'required' }, expected: 'policy' },
  { status: 403, headers: {}, expected: 'policy' },
  { status: 404, headers: {}, expected: 'unavailable' },
  { status: 429, headers: { 'retry-after': '60' }, expected: 'throttled' },
])(
  'API $status keeps an accurate $expected state without hidden retries',
  async ({ status, headers, expected }) => {
    let reads = 0;
    const connection = createGitHubConnection({
      getSession: async () => ({ accessToken: 'secret' }),
      fetch: async () => {
        reads += 1;
        return new Response('{}', {
          status,
          headers: { ...headers, 'content-type': 'application/json' },
        });
      },
      sleep: async () => {
        throw new Error('No early retry is allowed');
      },
    });
    const result = await connection.resolvePullRequest(
      'https://github.com/acme/export-service/pull/248',
      [],
    );
    expect(result).toMatchObject({ status: expected });
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  },
);

test('the actual Octokit transport stops after three failed reads', async () => {
  let reads = 0;
  const delays: number[] = [];
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    fetch: async () => {
      reads += 1;
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    },
    sleep: async (delay) => {
      delays.push(delay);
    },
  });
  await expect(
    connection.resolvePullRequest('https://github.com/acme/export-service/pull/248', []),
  ).resolves.toMatchObject({ status: 'unavailable' });
  expect(reads).toBe(3);
  expect(delays).toEqual([250, 1000]);
});

test('refusing authentication offers reconnect without exposing the provider error', async () => {
  const connection = createGitHubConnection({
    getSession: async () => {
      throw new Error('sensitive provider diagnostics');
    },
  });
  const result = await connection.resolvePullRequest(
    'https://github.com/acme/export-service/pull/248',
    [],
  );
  expect(result).toMatchObject({ status: 'reconnect' });
  expect(JSON.stringify(result)).not.toContain('sensitive');
});

test('oversize HTTP metadata is rejected as incomplete without saving a truncated record', async () => {
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    fetch: async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
  });
  await expect(
    connection.resolvePullRequest('https://github.com/acme/export-service/pull/248', []),
  ).resolves.toMatchObject({
    status: 'incomplete',
    detail: expect.stringContaining('bounded read size'),
  });
});

test('an inaccessible local remote retains its API authorization error', async () => {
  const pull = pullFixture();
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    fetch: async (input) =>
      String(input).includes('/fork/')
        ? new Response('{}', {
            status: 403,
            headers: { 'content-type': 'application/json', 'x-github-sso': 'required' },
          })
        : new Response(
            JSON.stringify(
              String(input).endsWith('/user')
                ? { id: 1001, login: 'reviewer' }
                : String(input).endsWith('/pulls/248')
                  ? pull
                  : pull.base.repo,
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
  });
  const result = await connection.resolvePullRequest(pull.html_url, [
    { owner: 'fork', repository: 'export-service', transport: 'ssh' },
  ]);
  expect(result).toMatchObject({ status: 'policy', detail: expect.stringContaining('SSO') });
  expect(JSON.stringify(result)).not.toContain('SSH');
});

test('deleted fork and author identities remain explicitly unavailable while the base PR resolves', async () => {
  const pull = { ...pullFixture(), head: { ...pullFixture().head, repo: null }, user: null };
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    fetch: async (input) =>
      new Response(
        JSON.stringify(
          String(input).endsWith('/user')
            ? { id: 1001, login: 'reviewer' }
            : String(input).endsWith('/pulls/248')
              ? pull
              : pull.base.repo,
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await expect(connection.resolvePullRequest(pull.html_url, [])).resolves.toMatchObject({
    status: 'ready',
    pullRequest: { author: null, head: { repository: null }, base: { repository: { id: '3001' } } },
  });
});

test('inconsistent base and PR identities are incomplete rather than accepted', async () => {
  const pull = pullFixture();
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'secret' }),
    fetch: async (input) =>
      new Response(
        JSON.stringify(
          String(input).endsWith('/user')
            ? { id: 1001, login: 'reviewer' }
            : String(input).endsWith('/pulls/248')
              ? pull
              : { id: 9999, full_name: 'acme/export-service' },
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await expect(connection.resolvePullRequest(pull.html_url, [])).resolves.toMatchObject({
    status: 'incomplete',
  });
});

test('session changes during a PR read fence its result', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pull = pullFixture();
  const connection = createGitHubConnection({
    getSession: async () => ({ accessToken: 'original-account-secret' }),
    fetch: async (input) => {
      if (String(input).endsWith('/pulls/248')) await waiting;
      return new Response(
        JSON.stringify(
          String(input).endsWith('/user')
            ? { id: 1001, login: 'reviewer' }
            : String(input).endsWith('/pulls/248')
              ? pull
              : pull.base.repo,
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = connection.resolvePullRequest(pull.html_url, []);
  await new Promise((resolve) => setTimeout(resolve, 10));
  connection.sessionChanged();
  finish();
  await expect(result).resolves.toMatchObject({
    status: 'unavailable',
    detail: expect.stringContaining('session changed'),
  });
});

export interface GitHubAccount {
  host: 'github.com';
  userId: string;
  login: string;
}

export interface GitHubRepositoryIdentity {
  id: string;
  name: string;
  fullName: string;
}

export interface PullRequestRevision {
  repository: GitHubRepositoryIdentity;
  ref: string;
  oid: string;
}

export interface PullRequestRecord {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  url: string;
  author: { userId: string; login: string };
  base: PullRequestRevision;
  head: PullRequestRevision;
}

export type PullRequestResolution =
  | { status: 'ready'; account: GitHubAccount; pullRequest: PullRequestRecord }
  | { status: 'unsupported'; detail: string }
  | { status: 'reconnect'; detail: string }
  | { status: 'unavailable'; detail: string; retryAfter?: number };

interface Session {
  accessToken: string;
}

interface GitHubResponse {
  data: unknown;
  headers: Record<string, unknown>;
}

interface GitHubClient {
  request(route: string, parameters?: Record<string, unknown>): Promise<GitHubResponse>;
}

interface GitHubConnectionOptions {
  getSession(): Promise<Session | undefined>;
  createClient(accessToken: string): GitHubClient;
  sleep(milliseconds: number): Promise<void>;
}

export interface GitHubConnection {
  resolvePullRequest(url: string): Promise<PullRequestResolution>;
  resolveRepository(
    owner: string,
    repository: string,
  ): Promise<GitHubRepositoryIdentity | undefined>;
}

export function createOctokitGitHubConnection(
  getSession: () => Promise<Session | undefined>,
): GitHubConnection {
  return createGitHubConnection({
    getSession,
    createClient: (accessToken) => {
      const client = new Octokit({
        auth: accessToken,
        userAgent: 'code-review-workbench/0.0.1',
        request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } },
      });
      return {
        request: (route, parameters) =>
          client.request(route as never, parameters as never) as Promise<GitHubResponse>,
      };
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

export function createGitHubConnection(options: GitHubConnectionOptions): GitHubConnection {
  return {
    async resolvePullRequest(url) {
      const target = parsePullRequestUrl(url);
      if (!target) {
        return {
          status: 'unsupported',
          detail:
            'Paste a complete GitHub.com pull request URL such as https://github.com/owner/repository/pull/123.',
        };
      }

      let session: Session | undefined;
      try {
        session = await options.getSession();
      } catch {
        return {
          status: 'reconnect',
          detail: 'GitHub sign-in was not completed. Saved work is unchanged; sign in and retry.',
        };
      }
      if (!session) {
        return { status: 'reconnect', detail: 'Sign in to GitHub in VS Code, then try again.' };
      }
      const client = options.createClient(session.accessToken);
      try {
        const actorResponse = await readWithRetry(options, () => client.request('GET /user'));
        const actor = actorRecord(actorResponse.data);
        const pullResponse = await readWithRetry(options, () =>
          client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', target),
        );
        return {
          status: 'ready',
          account: { host: 'github.com', ...actor },
          pullRequest: pullRequestRecord(pullResponse.data),
        };
      } catch (error) {
        return githubFailure(error);
      }
    },
    async resolveRepository(owner, repository) {
      if (!safeSegment(owner) || !safeSegment(repository)) return undefined;
      const session = await options.getSession();
      if (!session) return undefined;
      try {
        const client = options.createClient(session.accessToken);
        const response = await readWithRetry(options, () =>
          client.request('GET /repos/{owner}/{repo}', { owner, repo: repository }),
        );
        return repositoryRecord(response.data);
      } catch {
        return undefined;
      }
    },
  };
}

function parsePullRequestUrl(
  input: string,
): { owner: string; repo: string; pull_number: number } | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!match || !safeSegment(match[1]!) || !safeSegment(match[2]!)) return undefined;
  const pullNumber = Number(match[3]);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) return undefined;
  return { owner: match[1]!, repo: match[2]!, pull_number: pullNumber };
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
}

function actorRecord(value: unknown): { userId: string; login: string } {
  const actor = object(value);
  return { userId: identifier(actor.id), login: string(actor.login, 'actor login') };
}

function repositoryRecord(value: unknown): GitHubRepositoryIdentity {
  const repository = object(value);
  return {
    id: identifier(repository.id),
    name: string(repository.name, 'repository name'),
    fullName: string(repository.full_name, 'repository full name'),
  };
}

function revisionRecord(value: unknown): PullRequestRevision {
  const revision = object(value);
  return {
    repository: repositoryRecord(revision.repo),
    ref: string(revision.ref, 'Git ref'),
    oid: oid(revision.sha),
  };
}

function pullRequestRecord(value: unknown): PullRequestRecord {
  const pull = object(value);
  const author = object(pull.user);
  if (pull.state !== 'open' && pull.state !== 'closed') incomplete('pull request state');
  return {
    id: identifier(pull.id),
    number: positiveInteger(pull.number, 'pull request number'),
    title: string(pull.title, 'pull request title'),
    body: pull.body === null ? '' : string(pull.body, 'author description'),
    state: pull.state,
    draft: boolean(pull.draft, 'draft state'),
    url: githubUrl(pull.html_url),
    author: {
      userId: identifier(author.id),
      login: string(author.login, 'author login'),
    },
    base: revisionRecord(pull.base),
    head: revisionRecord(pull.head),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) incomplete('response object');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') incomplete(field);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') incomplete(field);
  return value;
}

function identifier(value: unknown): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)))
    incomplete('immutable identity');
  return String(value);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) incomplete(field);
  return value;
}

function oid(value: unknown): string {
  const result = string(value, 'commit identity');
  if (!/^[0-9a-f]{40,64}$/i.test(result)) incomplete('commit identity');
  return result;
}

function githubUrl(value: unknown): string {
  const result = string(value, 'pull request URL');
  if (!parsePullRequestUrl(result)) incomplete('pull request URL');
  return result;
}

function incomplete(field: string): never {
  throw new Error(`GitHub returned an incomplete ${field}.`);
}

function githubFailure(error: unknown): PullRequestResolution {
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined;
  if (status === 401) {
    return {
      status: 'reconnect',
      detail: 'The GitHub session expired. Sign in again, then retry.',
    };
  }
  const headers = errorHeaders(error);
  const sso = typeof headers['x-github-sso'] === 'string' ? headers['x-github-sso'] : undefined;
  if (status === 403 && sso) {
    return {
      status: 'unavailable',
      detail:
        'This GitHub organization requires authorization or SSO for the signed-in account. Authorize it in GitHub, then retry; saved work is unchanged.',
    };
  }
  if (status === 403 || status === 429) {
    return {
      status: 'unavailable',
      detail:
        'GitHub is throttling this read or the account lacks access. Wait for the shown GitHub limit or check organization policy, then retry; saved work is unchanged.',
      ...retryAfter(error),
    };
  }
  return {
    status: 'unavailable',
    detail:
      status === 404
        ? 'GitHub could not expose this pull request. A private resource may look missing when this account lacks access. Check access in GitHub, then retry.'
        : error instanceof Error && error.message.startsWith('GitHub returned an incomplete')
          ? `${error.message} Saved work is unchanged; retry the read.`
          : 'GitHub could not complete this read. Saved work is unchanged; check access or connectivity, then retry.',
  };
}

async function readWithRetry(
  options: GitHubConnectionOptions,
  read: () => Promise<GitHubResponse>,
): Promise<GitHubResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!retryableRead(error) || attempt === 2) throw error;
      const wait = retryAfter(error).retryAfter ?? [100, 250][attempt]!;
      await options.sleep(Math.min(wait, 5_000));
    }
  }
  throw lastError;
}

function retryableRead(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined;
  if (status === undefined || status === 408 || status === 429 || status >= 500) return true;
  if (status !== 403) return false;
  const headers = errorHeaders(error);
  return headers['retry-after'] !== undefined || String(headers['x-ratelimit-remaining']) === '0';
}

function retryAfter(error: unknown): { retryAfter?: number } {
  const value = errorHeaders(error)['retry-after'];
  const seconds =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfter: seconds * 1000 } : {};
}

function errorHeaders(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object' || !('response' in error)) return {};
  const response = error.response;
  if (!response || typeof response !== 'object' || !('headers' in response)) return {};
  const headers = response.headers;
  return headers && typeof headers === 'object' ? (headers as Record<string, unknown>) : {};
}
import { Octokit } from 'octokit';

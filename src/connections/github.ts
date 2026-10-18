import { Octokit } from 'octokit';
import type {
  AccessFailure,
  GitHubConnection,
  GitHubRemote,
  GitHubRepositoryIdentity,
  PullRequestRecord,
  PullRequestResolution,
  PullRequestRevision,
} from '../application/pull-request';

interface GitHubOptions {
  getSession(forceNewSession?: boolean): Promise<{ accessToken: string } | undefined>;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

// Only this connection sees credentials or SDK response/error objects.
export function createGitHubConnection(options: GitHubOptions): GitHubConnection {
  let generation = 0;
  let reconnect = false;
  const pending = new Set<AbortController>();
  return {
    sessionChanged() {
      generation += 1;
      for (const controller of pending) controller.abort();
    },
    async resolvePullRequest(input, remotes): Promise<PullRequestResolution> {
      const target = parsePullRequestUrl(input);
      if (!target)
        return {
          status: 'unsupported',
          detail:
            'Paste a complete GitHub.com pull request URL such as https://github.com/owner/repository/pull/123.',
        };
      let session;
      try {
        session = await options.getSession(reconnect);
        reconnect = false;
      } catch {
        return {
          status: 'reconnect',
          detail:
            'GitHub sign-in was not completed. Sign in through VS Code and Retry. Saved work is unchanged.',
        };
      }
      if (!session)
        return {
          status: 'reconnect',
          detail: 'Sign in to GitHub through VS Code and Retry. Saved work is unchanged.',
        };
      // A consent-driven session event can occur during getSession. Verify that
      // returned session; subsequent session changes abort this operation.
      const sessionGeneration = generation;
      const controller = new AbortController();
      const operationSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
      pending.add(controller);
      const client = new Octokit({
        auth: session.accessToken,
        userAgent: 'code-review-workbench/0.0.1',
        retry: { enabled: false },
        throttle: { enabled: false },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        request: {
          fetch: boundedFetch(options.fetch ?? globalThis.fetch),
          signal: operationSignal,
          headers: { 'x-github-api-version': '2026-03-10', accept: 'application/vnd.github+json' },
        },
      });
      async function read(route: string, parameters: Record<string, unknown> = {}) {
        for (let attempt = 0; ; attempt += 1) {
          if (controller.signal.aborted || generation !== sessionGeneration)
            throw new AccessError(staleRead());
          try {
            const response = await client.request(route, {
              ...parameters,
              headers: {
                'x-github-api-version': '2026-03-10',
                accept: 'application/vnd.github+json',
              },
              request: {
                signal: AbortSignal.any([operationSignal, AbortSignal.timeout(5_000)]),
              },
            });
            if (generation !== sessionGeneration || controller.signal.aborted)
              throw new AccessError(staleRead());
            return response.data as unknown;
          } catch (error) {
            if (error instanceof AccessError) throw error;
            if (error instanceof Error && error.cause instanceof AccessError) throw error.cause;
            const failure = classify(error, options.now?.() ?? Date.now());
            // Honor long server delays by returning a Retry state, never retry
            // earlier than Retry-After/reset or let SDK plugins wait indefinitely.
            if (
              operationSignal.aborted ||
              attempt >= 2 ||
              !failure.retryable ||
              (failure.result.retryAfter ?? 0) > 2_000
            ) {
              throw new AccessError(failure.result);
            }
            const delay = failure.result.retryAfter ?? [250, 1_000][attempt]!;
            await (options.sleep ?? sleep)(delay);
          }
        }
      }
      try {
        const user = object(await read('GET /user'));
        const account = {
          host: 'github.com' as const,
          userId: identifier(user.id),
          login: nonempty(user.login, 'account login', 128),
        };
        const base = repositoryRecord(
          await read('GET /repos/{owner}/{repo}', { owner: target.owner, repo: target.repo }),
        );
        const pull = pullRequestRecord(
          await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', target),
        );
        if (
          pull.base.repository.id !== base.id ||
          pull.number !== target.pull_number ||
          pull.base.repository.fullName !== base.fullName
        )
          incomplete('repository/PR identity');
        const repositories: Extract<PullRequestResolution, { status: 'ready' }>['repositories'] =
          [];
        if (remotes.length > 16)
          return {
            status: 'unsupported',
            detail:
              'This repository has too many GitHub remotes for a bounded overview read. Keep at most 16 relevant GitHub remotes and Retry.',
          };
        let remoteFailure: AccessFailure | undefined;
        for (const remote of remotes) {
          try {
            const fullName = `${remote.owner}/${remote.repository}`;
            const identity =
              fullName.toLowerCase() === base.fullName.toLowerCase()
                ? base
                : repositoryRecord(
                    await read('GET /repos/{owner}/{repo}', {
                      owner: remote.owner,
                      repo: remote.repository,
                    }),
                  );
            repositories.push({ identity, remote });
          } catch (error) {
            if (
              !(error instanceof AccessError) ||
              error.failure.status === 'reconnect' ||
              controller.signal.aborted
            )
              throw error;
            remoteFailure = error.failure;
          }
        }
        if (generation !== sessionGeneration) return staleRead();
        const hasEligibleRemote = repositories.some(
          (item) =>
            item.identity.id === pull.base.repository.id ||
            item.identity.id === pull.head.repository?.id,
        );
        if (!hasEligibleRemote && remoteFailure) return remoteFailure;
        return {
          status: 'ready',
          account,
          pullRequest: pull,
          repositories,
          ...(remoteFailure ? { unverifiedRemotes: true as const } : {}),
        };
      } catch (error) {
        if (generation !== sessionGeneration || controller.signal.aborted) return staleRead();
        if (error instanceof AccessError) {
          if (error.failure.status === 'reconnect') reconnect = true;
          return error.failure;
        }
        return {
          status: 'incomplete',
          detail:
            'GitHub returned incomplete or inconsistent account/PR metadata. Saved work is unchanged. Retry this read.',
        };
      } finally {
        pending.delete(controller);
        // Do not retain SDK clients or access tokens between operations.
      }
    },
  };
}

function boundedFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new AccessError({
          status: 'incomplete',
          detail:
            'GitHub metadata exceeded the bounded read size. No truncated metadata was saved.',
        });
      }
      chunks.push(item.value);
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function parsePullRequestUrl(
  input: string,
): { owner: string; repo: string; pull_number: number } | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return undefined;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match || ['.', '..'].includes(match[1]!) || ['.', '..'].includes(match[2]!))
    return undefined;
  const pull_number = Number(match[3]);
  return Number.isSafeInteger(pull_number)
    ? { owner: match[1]!, repo: match[2]!, pull_number }
    : undefined;
}

function repositoryRecord(value: unknown): GitHubRepositoryIdentity {
  const repository = object(value);
  const fullName = nonempty(repository.full_name, 'repository name', 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) incomplete('repository name');
  return { id: identifier(repository.id), fullName };
}

function revisionRecord(value: unknown, allowMissing: boolean): PullRequestRevision {
  const revision = object(value);
  const oid = nonempty(revision.sha, 'commit identity', 64);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) incomplete('commit identity');
  return {
    repository: allowMissing && revision.repo === null ? null : repositoryRecord(revision.repo),
    ref: nonempty(revision.ref, 'ref', 1024),
    oid,
  };
}

function pullRequestRecord(value: unknown): PullRequestRecord {
  const pull = object(value);
  if (
    !Number.isSafeInteger(pull.number) ||
    Number(pull.number) < 1 ||
    !['open', 'closed'].includes(String(pull.state)) ||
    typeof pull.draft !== 'boolean' ||
    typeof pull.merged !== 'boolean'
  )
    incomplete('PR state');
  const base = revisionRecord(pull.base, false);
  if (!base.repository) incomplete('base repository');
  const url = nonempty(pull.html_url, 'PR URL', 1024);
  const target = parsePullRequestUrl(url);
  if (
    !target ||
    target.pull_number !== pull.number ||
    `${target.owner}/${target.repo}`.toLowerCase() !== base.repository.fullName.toLowerCase()
  )
    incomplete('PR destination');
  const author = pull.user === null ? null : object(pull.user);
  return {
    id: identifier(pull.id),
    number: Number(pull.number),
    title: nonempty(pull.title, 'title', 16_384),
    body: pull.body === null ? '' : boundedText(pull.body, 'author description', 1_048_576),
    state: pull.merged ? 'merged' : (pull.state as 'open' | 'closed'),
    draft: pull.draft,
    url,
    author: author
      ? { userId: identifier(author.id), login: nonempty(author.login, 'author login', 128) }
      : null,
    base: { ...base, repository: base.repository },
    head: revisionRecord(pull.head, true),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) incomplete('object');
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit || value.includes('\0'))
    incomplete(field);
  return value;
}
function nonempty(value: unknown, field: string, limit: number): string {
  const result = boundedText(value, field, limit);
  if (!result) incomplete(field);
  return result;
}
function identifier(value: unknown): string {
  if (
    typeof value === 'number'
      ? !Number.isSafeInteger(value) || value < 1
      : typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)
  )
    incomplete('immutable ID');
  return String(value);
}
function incomplete(field: string): never {
  throw new Error(`Incomplete ${field}`);
}
class AccessError extends Error {
  constructor(readonly failure: AccessFailure) {
    super(failure.status);
  }
}
function staleRead(): AccessFailure {
  return {
    status: 'unavailable',
    detail:
      'The GitHub session changed during this read. Reconnect the original account and Retry.',
  };
}
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function classify(error: unknown, now: number): { result: AccessFailure; retryable: boolean } {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const response =
    value.response && typeof value.response === 'object'
      ? (value.response as Record<string, unknown>)
      : {};
  const headers =
    response.headers && typeof response.headers === 'object'
      ? (response.headers as Record<string, unknown>)
      : {};
  const status = typeof value.status === 'number' ? value.status : 0;
  if (status === 401)
    return {
      result: {
        status: 'reconnect',
        detail:
          'The GitHub session expired. Sign in through VS Code and Retry; saved work is unchanged.',
      },
      retryable: false,
    };
  if (status === 403 && headers['x-github-sso'])
    return {
      result: {
        status: 'policy',
        detail:
          'GitHub organization SSO authorization is required. Authorize this account in GitHub, then Retry.',
      },
      retryable: false,
    };
  const throttled =
    status === 429 ||
    (status === 403 &&
      (headers['retry-after'] !== undefined ||
        String(headers['x-ratelimit-remaining']) === '0' ||
        /secondary rate limit/i.test(
          String((response.data as { message?: unknown } | undefined)?.message ?? '').slice(
            0,
            4096,
          ),
        )));
  if (throttled) {
    const seconds = Number(headers['retry-after']);
    const reset = Number(headers['x-ratelimit-reset']);
    const delay =
      Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : Number.isFinite(reset)
          ? Math.max(0, reset * 1000 - now)
          : 60_000;
    return {
      result: {
        status: 'throttled',
        detail:
          'GitHub throttled this metadata read. Wait for the retry delay, then Retry. Saved work is unchanged.',
        retryAfter: delay,
      },
      retryable: true,
    };
  }
  if (status === 403)
    return {
      result: {
        status: 'policy',
        detail:
          'GitHub denied this metadata read. Check repository permissions and organization policy for this account, then Retry.',
      },
      retryable: false,
    };
  if (status === 404)
    return {
      result: {
        status: 'unavailable',
        detail:
          'GitHub could not expose this resource. A private repository or PR may return 404 when this account lacks access; this does not establish deletion. Check access in GitHub and Retry.',
      },
      retryable: false,
    };
  return {
    result: {
      status: 'unavailable',
      detail:
        'GitHub could not complete this metadata read within its time limit. Check API connectivity and Retry; saved work is unchanged.',
    },
    retryable: status === 0 || status === 408 || status >= 500,
  };
}

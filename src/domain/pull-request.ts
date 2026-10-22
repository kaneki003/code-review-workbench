export interface GitHubAccount {
  host: 'github.com';
  userId: string;
  login: string;
}

export interface GitHubRepositoryIdentity {
  id: string;
  fullName: string;
}

export interface GitHubRemote {
  owner: string;
  repository: string;
  transport: 'https' | 'ssh';
}

export interface PullRequestRevision {
  repository: GitHubRepositoryIdentity | null;
  ref: string;
  oid: string;
}

export interface PullRequestRecord {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  url: string;
  author: { userId: string; login: string } | null;
  base: PullRequestRevision & { repository: GitHubRepositoryIdentity };
  head: PullRequestRevision;
}

export type AccessFailure = {
  status: 'unsupported' | 'reconnect' | 'policy' | 'throttled' | 'unavailable' | 'incomplete';
  detail: string;
  retryAfter?: number;
};

export type PullRequestResolution =
  | {
      status: 'ready';
      account: GitHubAccount;
      pullRequest: PullRequestRecord;
      repositories: { identity: GitHubRepositoryIdentity; remote: GitHubRemote }[];
      unverifiedRemotes?: true;
    }
  | AccessFailure;

export interface GitHubConnection {
  resolvePullRequest(url: string, remotes: GitHubRemote[]): Promise<PullRequestResolution>;
  sessionChanged(): void;
}

export interface DirectoryIdentity {
  path: string;
  device: string;
  inode: string;
}

export interface LocalRepositoryFacts {
  worktree: DirectoryIdentity;
  gitDirectory: DirectoryIdentity;
  commonDirectory: DirectoryIdentity;
  remotes: GitHubRemote[];
}

export interface LocalRepositoryConnection {
  inspect(path: string): Promise<LocalRepositoryFacts>;
}

export interface LocalRepositoryRegistration {
  confirmation: 'user-confirmed';
  unverifiedRemotes?: true;
  facts: LocalRepositoryFacts;
  repositoryId: string;
  relation: 'base' | 'head';
  remote: GitHubRemote;
}

export interface ReviewCandidate {
  account: GitHubAccount;
  pullRequest: PullRequestRecord;
  localRepository: LocalRepositoryRegistration;
}

export type PullRequestOverview =
  | ({ status: 'ready' } & ReviewCandidate)
  | AccessFailure
  | { status: 'stale' | 'local-required' | 'blocked'; detail: string };

export function sameLocalRepository(
  left: LocalRepositoryFacts,
  right: LocalRepositoryFacts,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Rebuild only the known record fields at the storage seam. Unknown fields
// (including provider sessions/tokens) can never become durable receipt data.
export function normalizeCandidate(input: unknown): ReviewCandidate {
  const candidate = record(input);
  const account = record(candidate.account);
  if (account.host !== 'github.com') invalid();
  const pull = record(candidate.pullRequest);
  const local = record(candidate.localRepository);
  const facts = record(local.facts);
  const base = revision(pull.base);
  if (
    !base.repository ||
    !Number.isSafeInteger(pull.number) ||
    Number(pull.number) < 1 ||
    !['open', 'closed', 'merged'].includes(String(pull.state)) ||
    typeof pull.draft !== 'boolean' ||
    !['base', 'head'].includes(String(local.relation))
  )
    invalid();
  const head = revision(pull.head);
  const repositoryId = id(local.repositoryId);
  if (repositoryId !== (local.relation === 'base' ? base.repository.id : head.repository?.id))
    invalid();
  const url = field(pull.url, 1024);
  if (url !== `https://github.com/${base.repository.fullName}/pull/${pull.number}`) invalid();
  const author = pull.author === null ? null : record(pull.author);
  if (!Array.isArray(facts.remotes) || facts.remotes.length > 16) invalid();
  return {
    account: { host: 'github.com', userId: id(account.userId), login: field(account.login, 128) },
    pullRequest: {
      id: id(pull.id),
      number: Number(pull.number),
      title: field(pull.title, 16_384),
      body: field(pull.body, 1_048_576, true),
      state: pull.state as PullRequestRecord['state'],
      draft: pull.draft,
      url,
      author: author ? { userId: id(author.userId), login: field(author.login, 128) } : null,
      base: { ...base, repository: base.repository },
      head,
    },
    localRepository: {
      confirmation: local.confirmation === 'user-confirmed' ? 'user-confirmed' : invalid(),
      ...(local.unverifiedRemotes === true ? { unverifiedRemotes: true as const } : {}),
      facts: {
        worktree: directory(facts.worktree),
        gitDirectory: directory(facts.gitDirectory),
        commonDirectory: directory(facts.commonDirectory),
        remotes: facts.remotes.map(remote),
      },
      repositoryId,
      relation: local.relation as 'base' | 'head',
      remote: remote(local.remote),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function field(value: unknown, limit = 32768, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value) ||
    value.includes('\0') ||
    Buffer.byteLength(value) > limit
  )
    invalid();
  return value;
}
function id(value: unknown): string {
  const result = field(value, 20);
  if (!/^[1-9]\d*$/.test(result)) invalid();
  return result;
}
function repository(value: unknown): GitHubRepositoryIdentity {
  const repo = record(value);
  const fullName = field(repo.fullName, 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) invalid();
  return { id: id(repo.id), fullName };
}
function revision(value: unknown): PullRequestRevision {
  const rev = record(value);
  const oid = field(rev.oid, 64);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) invalid();
  return {
    repository: rev.repository === null ? null : repository(rev.repository),
    ref: field(rev.ref, 1024),
    oid,
  };
}
function directory(value: unknown): DirectoryIdentity {
  const entry = record(value);
  const path = field(entry.path);
  if (
    !/^(?:\/|[A-Za-z]:[\\/])/.test(path) ||
    !/^\d+$/.test(String(entry.device)) ||
    !/^[1-9]\d*$/.test(String(entry.inode))
  )
    invalid();
  return { path, device: field(entry.device, 32), inode: field(entry.inode, 32) };
}
function remote(value: unknown): GitHubRemote {
  const entry = record(value);
  const owner = field(entry.owner, 128),
    repository = field(entry.repository, 128);
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository) ||
    !['https', 'ssh'].includes(String(entry.transport))
  )
    invalid();
  return { owner, repository, transport: entry.transport as 'https' | 'ssh' };
}
function invalid(): never {
  throw new Error('Invalid review candidate');
}

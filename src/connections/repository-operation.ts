import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, isAbsolute, join, normalize, relative } from 'node:path';
import type { StoreLease, StoreProcess } from '../application/private-store';
import type { PriorWork } from '../application/prior-work';
import {
  findPriorStash,
  matchesManifest,
  priorWorkRef,
  validPriorWork,
  verifyStash,
} from './prior-work';
import { StoreError } from '../application/private-store';
import {
  inspectReferenceStorage,
  sameReferenceStorage,
  referencePaths,
  type ReferencePath,
} from './reference-storage';
import {
  object,
  readRecord,
  recovery,
  sequence,
  text,
  uuid,
  type NativeStore,
} from './store-records';

export interface RepositoryFacts {
  worktree: string;
  commonGitDir: string;
  gitDir: string;
  index: string;
  scopes: string[];
  digest: string;
}
export interface OperationRecord {
  protocol: 1;
  id: string;
  storeId: string;
  incarnation: string;
  fence: number;
  ownerToken: string;
  scopeId: string;
  kind: 'update-ref' | 'fetch' | 'checkout' | 'delete-ref' | 'stash-push' | 'stash-apply';
  stash?: { prior: PriorWork; original: CheckoutState };
  fetch?: { url: string; remoteRef: string };
  checkout?: {
    before: CheckoutState;
    target: { branch: string | null; commit: string; fingerprint?: string };
    create: boolean;
    entryId?: string;
  };
  observedOid?: string | null;
  phase: 'prepared' | 'armed' | 'observed';
  ref: string;
  newOid: string;
  beforeOid: string | null;
  facts: RepositoryFacts;
  storage: ReferencePath[];
  child: StoreProcess | null;
  outcome?: 'applied' | 'not-applied' | 'refused';
  exitCode?: number;
}
export interface CheckoutState {
  branch: string | null;
  commit: string;
  fingerprint: string;
}
function checkoutState(value: unknown): value is CheckoutState {
  return (
    object(value) &&
    (value.branch === null ||
      (text(value.branch, 512) && value.branch.startsWith('refs/heads/'))) &&
    oid(value.commit) &&
    text(value.fingerprint, 64)
  );
}
export function oid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
export function operationFile(directory: string, id: string) {
  if (!uuid(id)) recovery('Operation identity is invalid.');
  return join(directory, `operation-${id}.json`);
}
export function originalCheckoutRef(entryId: string) {
  if (!uuid(entryId)) recovery('The original checkout reference needs an entry identity.');
  return `refs/code-review-workbench/recovery/${entryId}/original`;
}
export function readOperation(directory: string, id: string): OperationRecord {
  const value = readRecord(operationFile(directory, id));
  if (
    !object(value) ||
    value.protocol !== 1 ||
    value.id !== id ||
    !uuid(value.storeId) ||
    !uuid(value.incarnation) ||
    !uuid(value.ownerToken) ||
    !uuid(value.scopeId) ||
    !sequence(value.fence) ||
    !['update-ref', 'fetch', 'checkout', 'delete-ref', 'stash-push', 'stash-apply'].includes(
      String(value.kind),
    ) ||
    (String(value.kind).startsWith('stash-') &&
      (!object(value.stash) ||
        !validPriorWork(value.stash.prior) ||
        !checkoutState(value.stash.original))) ||
    (value.kind === 'delete-ref' &&
      (value.beforeOid === null || value.beforeOid !== value.newOid)) ||
    (value.kind === 'checkout' &&
      (!object(value.checkout) ||
        !checkoutState(value.checkout.before) ||
        !object(value.checkout.target) ||
        !oid(value.checkout.target.commit) ||
        !(
          value.checkout.target.branch === null ||
          (text(value.checkout.target.branch, 512) &&
            value.checkout.target.branch.startsWith('refs/heads/'))
        ) ||
        (value.checkout.target.fingerprint !== undefined &&
          !text(value.checkout.target.fingerprint, 64)) ||
        typeof value.checkout.create !== 'boolean' ||
        (value.checkout.entryId !== undefined && !uuid(value.checkout.entryId)))) ||
    (value.kind === 'fetch' &&
      (!object(value.fetch) ||
        !/^https:\/\/github.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$|^git@github.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
          String(value.fetch.url),
        ) ||
        !text(value.fetch.remoteRef, 1024) ||
        !String(value.fetch.remoteRef).startsWith('refs/'))) ||
    (value.observedOid !== undefined && value.observedOid !== null && !oid(value.observedOid)) ||
    !['prepared', 'armed', 'observed'].includes(String(value.phase)) ||
    !text(value.ref, 512) ||
    !oid(value.newOid) ||
    (value.beforeOid !== null && !oid(value.beforeOid)) ||
    (!['checkout', 'delete-ref', 'stash-push', 'stash-apply'].includes(String(value.kind)) &&
      value.beforeOid === value.newOid) ||
    !object(value.facts) ||
    !text(value.facts.worktree) ||
    !text(value.facts.commonGitDir) ||
    !text(value.facts.gitDir) ||
    !text(value.facts.index) ||
    !Array.isArray(value.facts.scopes) ||
    value.facts.scopes.length !== 2 ||
    !value.facts.scopes.every((scope) => text(scope, 32768)) ||
    !text(value.facts.digest, 64) ||
    !referencePaths(value.storage) ||
    (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode)) ||
    (value.child !== null &&
      (!object(value.child) ||
        !sequence(value.child.pid) ||
        value.child.pid < 1 ||
        !text(value.child.start, 128))) ||
    (value.phase === 'armed' && value.child === null) ||
    (value.phase === 'observed' &&
      !['applied', 'not-applied', 'refused'].includes(String(value.outcome)))
  )
    recovery('Operation recovery record is malformed or unsupported.');
  return value as unknown as OperationRecord;
}

// Only typed reference, fetch and protected checkout operations reach the launcher.
// Hooks, lazy fetch, filesystem monitors, inherited Git targets/config and
// executable-injection variables are disabled; arbitrary commands are absent.
export class RepositoryOperation {
  readonly executable: string;
  readonly environment: Record<string, string>;
  private readonly prefix: string[];
  constructor(
    private readonly location: string,
    hooksDirectory: string,
    private readonly native: NativeStore,
  ) {
    native.assertLocalDirectory(location);
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    const candidates = (process.env.PATH ?? '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((path) => join(path, name));
    const candidate = candidates.find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    });
    if (!candidate)
      throw new StoreError('GIT_UNAVAILABLE', 'Git is not available on the host PATH.');
    this.executable = realpathSync(candidate);
    const magic = readFileSync(this.executable).subarray(0, 4).toString('hex');
    if (
      ![
        '7f454c46',
        'cffaedfe',
        'feedfacf',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ].includes(magic) &&
      !magic.startsWith('4d5a')
    )
      throw new StoreError(
        'UNSUPPORTED_GIT',
        'Repository mutations require a native Git executable; script wrappers are unsupported.',
      );
    this.environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' &&
          !entry[0].includes('=') &&
          !/^(GIT_|LD_|DYLD_)/i.test(entry[0]),
      ),
    );
    Object.assign(this.environment, {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    });
    this.prefix = [
      '--no-pager',
      '--no-lazy-fetch',
      '-c',
      `core.hooksPath=${hooksDirectory}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.filesRefLockTimeout=4000',
      '-c',
      'user.name=Code Review Workbench',
      '-c',
      'user.email=workbench@localhost',
      '-C',
      location,
    ];
  }
  git(args: string[], optional = false): Buffer | null {
    try {
      return execFileSync(this.executable, [...this.prefix, ...args], {
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      if (optional && (error as { status?: number }).status === 1) return null;
      throw new StoreError(
        'GIT_INSPECTION',
        'Git could not inspect the repository without external helpers. No mutation was authorized.',
      );
    }
  }
  readArguments(args: string[]): string[] {
    return [...this.prefix, ...args];
  }
  validateFetch(ref: string, newOid: string, remoteRef: string) {
    if (!ref.startsWith('refs/code-review-workbench/sources/') || !oid(newOid))
      throw new StoreError(
        'INVALID_OPERATION',
        'Fetch requires a source-owned reference and metadata object identity.',
      );
    this.git(['check-ref-format', ref]);
    this.git(['check-ref-format', remoteRef]);
    const backend = this.git(['config', '--get', 'extensions.refStorage'], true)?.toString().trim();
    if (backend && backend !== 'files')
      throw new StoreError(
        'UNSUPPORTED_GIT',
        'Source fetch currently requires file-based reference storage.',
      );
  }
  refOid(ref: string): string | null {
    const result = this.git(['rev-parse', '--verify', '--quiet', ref], true);
    const value = result?.toString().trim() ?? null;
    if (value !== null && !oid(value)) recovery('A reference has an unsupported object identity.');
    return value;
  }
  validateUpdate(ref: unknown, newOid: unknown) {
    if (
      !text(ref, 512) ||
      !ref.startsWith('refs/code-review-workbench/') ||
      !/^[a-zA-Z0-9._/-]+$/.test(ref) ||
      !oid(newOid)
    )
      throw new StoreError(
        'INVALID_OPERATION',
        'Use a workbench-owned reference and an exact commit object ID.',
      );
    this.git(['check-ref-format', ref]);
    this.git(['cat-file', '-e', `${newOid}^{commit}`]);
    const backend = this.git(['config', '--get', 'extensions.refStorage'], true)?.toString().trim();
    if (backend && backend !== 'files')
      throw new StoreError(
        'UNSUPPORTED_GIT',
        'This operation currently requires Git file-based reference storage.',
      );
  }
  referenceStorage(ref: string, facts: RepositoryFacts, checkout = false) {
    return [
      ...inspectReferenceStorage(facts.commonGitDir, ref, this.native),
      ...(checkout ? inspectReferenceStorage(facts.gitDir, 'HEAD', this.native) : []),
    ];
  }
  sameReferenceStorage(record: OperationRecord, settled = false) {
    return sameReferenceStorage(
      record.storage,
      this.referenceStorage(record.ref, record.facts, record.kind === 'checkout'),
      settled,
      record.kind === 'delete-ref',
    );
  }
  facts(includeIndexCache = true): RepositoryFacts {
    const paths = this.git([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
      '--git-path',
      'index',
      '--absolute-git-dir',
    ])!
      .toString()
      .trimEnd()
      .split(/\r?\n/)
      .map(normalize);
    if (paths.length !== 4 || paths[0] !== this.location)
      recovery('Repository discovery no longer matches this window.');
    const [worktree, commonGitDir, index, gitDir] = paths as [string, string, string, string];
    const scopes = [worktree, commonGitDir]
      .map((path) => {
        this.native.assertLocalDirectory(path);
        const info = statSync(path, { bigint: true });
        return `${info.dev}:${info.ino}:${path}`;
      })
      .sort();
    const digest = createHash('sha256').update(JSON.stringify(scopes));
    this.native.assertLocalDirectory(gitDir);
    const admin = statSync(gitDir, { bigint: true });
    digest.update(`${admin.dev}:${admin.ino}:${gitDir}:${index}`);
    digest.update(this.git(['symbolic-ref', '-q', 'HEAD'], true) ?? 'detached');
    digest.update(this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], true) ?? 'unborn');
    if (existsSync(index)) {
      if (!lstatSync(index).isFile()) recovery('The repository index is redirected.');
      if (includeIndexCache) digest.update(readFileSync(index));
    } else digest.update('no-index');
    digest.update(this.git(['ls-files', '--stage', '-z'])!);
    const files = [
      ...new Set(
        new TextDecoder('utf-8', { fatal: true })
          .decode(this.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])!)
          .split('\0')
          .filter(Boolean),
      ),
    ].sort();
    if (files.length > 10000)
      throw new StoreError(
        'REPOSITORY_LIMIT',
        'Repository fact validation exceeds the current 10,000-file bound.',
      );
    let bytes = 0;
    for (const file of files) {
      const path = join(worktree, file),
        local = relative(worktree, path);
      if (isAbsolute(local) || local.startsWith('..'))
        recovery('A repository file escapes the worktree.');
      digest.update(file).update('\0');
      let before;
      try {
        before = lstatSync(path, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        digest.update('missing');
        continue;
      }
      digest.update(String(before.mode));
      if (before.isSymbolicLink()) digest.update(readlinkSync(path));
      else if (before.isFile()) {
        bytes += Number(before.size);
        if (bytes > 128 * 1024 * 1024)
          throw new StoreError(
            'REPOSITORY_LIMIT',
            'Repository fact validation exceeds the current 128 MiB bound.',
          );
        digest.update(readFileSync(path));
        const after = lstatSync(path, { bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs
        )
          throw new StoreError(
            'REPOSITORY_CHANGED',
            'A file changed while checking repository facts.',
          );
      } else if (before.isDirectory()) digest.update(`gitlink:${before.dev}:${before.ino}`);
      else recovery('A repository file has an unsupported type.');
    }
    return { worktree, commonGitDir, gitDir, index, scopes, digest: digest.digest('hex') };
  }
  sameFacts(expected: RepositoryFacts) {
    return JSON.stringify(this.facts()) === JSON.stringify(expected);
  }
  sameRepositoryIdentity(expected: RepositoryFacts) {
    const actual = this.facts();
    return (
      JSON.stringify(actual.scopes) === JSON.stringify(expected.scopes) &&
      actual.gitDir === expected.gitDir &&
      actual.index === expected.index
    );
  }
  validateDelete(ref: string, commit: string) {
    if (
      !/^refs\/(?:heads\/code-review-workbench\/[a-f0-9-]{36}|code-review-workbench\/recovery\/[a-f0-9-]{36}\/(?:original|prior-work))$/.test(
        ref,
      ) ||
      !oid(commit)
    )
      throw new StoreError(
        'INVALID_OPERATION',
        'Cleanup requires an exact proven-owned checkout artifact.',
      );
    this.git(['check-ref-format', ref]);
    this.git(['cat-file', '-e', `${commit}^{commit}`]);
    if (
      this.git(['worktree', 'list', '--porcelain', '-z'])!
        .toString()
        .split('\0')
        .includes(`branch ${ref}`)
    )
      throw new StoreError(
        'CHECKOUT_INTERFERENCE',
        'The branch is now in use by a worktree. Keep it reachable.',
      );
  }
  mergedIntoHead(commit: string) {
    return this.git(['merge-base', '--is-ancestor', commit, 'HEAD'], true) !== null;
  }
  checkoutState(target?: string, requirement: 'clean' | 'inventory' = 'clean'): CheckoutState {
    // Refuse configurations whose checkout/status can execute repository-owned
    // programs, and representations this clean-only slice cannot verify.
    const backend = this.git(['config', '--get', 'extensions.refStorage'], true)?.toString().trim();
    if (
      (backend && backend !== 'files') ||
      this.git(['rev-parse', '--shared-index-path'])!.toString().trim() ||
      this.git(
        [
          'config',
          '--get-regexp',
          '^(filter\\.|core\\.sparsecheckout|core\\.splitindex|extensions\\.worktreeconfig)',
        ],
        true,
      )
    )
      throw new StoreError(
        'UNSUPPORTED_CHECKOUT',
        'Configured filters, sparse/split index, worktree config and non-file references require validated preservation support. Keep reading committed source without switching.',
      );
    const facts = this.facts();
    for (const marker of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'REBASE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'BISECT_START',
      'index.lock',
      'HEAD.lock',
    ]) {
      if (existsSync(join(facts.gitDir, marker)))
        throw new StoreError(
          'UNSUPPORTED_CHECKOUT',
          'An in-progress Git operation or lock prevents checkout. Finish it before Retry.',
        );
    }
    const staged = this.git(['ls-files', '--stage', '-z'])!.toString();
    const flags = this.git(['ls-files', '-v', '-z'])!.toString().split('\0').filter(Boolean);
    if (
      /(?:^|\0)160000 | [1-3]\t/.test(staged) ||
      flags.some((file) => !file.startsWith('H ')) ||
      (target && /(?:^|\0)160000 /.test(this.git(['ls-tree', '-r', '-z', target])!.toString()))
    )
      throw new StoreError(
        'UNSUPPORTED_CHECKOUT',
        'Submodules, unresolved entries and special index flags are not supported by clean checkout. Keep no-switch reading.',
      );
    if (
      requirement === 'clean' &&
      this.git([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ])!.length
    )
      throw new StoreError(
        'DIRTY_CHECKOUT',
        'Unfinished index/worktree changes prevent this clean-only checkout. Commit or preserve them using ordinary Git, then Retry; committed-source reading remains available.',
      );
    // Status can trust cached stat fields even when bytes differ. Verify each
    // indexed blob directly, without invoking filters or refreshing the index.
    // Transformed working-file representations remain a safe no-switch case.
    for (const entry of requirement === 'inventory' ? [] : staged.split('\0').filter(Boolean)) {
      const match = /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/s.exec(entry);
      if (!match)
        throw new StoreError(
          'UNSUPPORTED_CHECKOUT',
          'An index entry has an unsupported representation.',
        );
      const mode = match[1]!,
        expected = match[2]!,
        file = match[3]!;
      const path = join(facts.worktree, file);
      const metadata = lstatSync(path);
      const symlink = metadata.isSymbolicLink();
      if ((mode === '120000') !== symlink || (!symlink && !metadata.isFile()))
        throw new StoreError(
          'DIRTY_CHECKOUT',
          'A working-file type differs from its indexed type. Keep no-switch reading.',
        );
      const content = symlink ? Buffer.from(readlinkSync(path)) : readFileSync(path);
      const actual = createHash(expected.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex');
      if (
        actual !== expected ||
        (process.platform !== 'win32' &&
          !symlink &&
          Boolean(metadata.mode & 0o111) !== (mode === '100755'))
      )
        throw new StoreError(
          'DIRTY_CHECKOUT',
          'Working-file bytes or modes differ from the index. Preserve any edits; transformed files require supported handling before switching. Keep no-switch reading.',
        );
    }
    const commit = this.refOid('HEAD');
    if (!commit)
      throw new StoreError(
        'UNSUPPORTED_CHECKOUT',
        'An unborn repository cannot enter a PR checkout.',
      );
    const state = {
      branch: this.git(['symbolic-ref', '-q', 'HEAD'], true)?.toString().trim() ?? null,
      commit,
      fingerprint: this.facts(false).digest,
    };
    if (!this.sameFacts(facts))
      throw new StoreError(
        'REPOSITORY_CHANGED',
        'Repository facts changed during clean-content verification. No checkout was authorized.',
      );
    return state;
  }
  validateCheckout(record: OperationRecord) {
    const checkout = record.checkout!;
    const original = checkout.create ? checkout.before.commit : checkout.target.commit;
    if (this.refOid(originalCheckoutRef(checkout.entryId ?? record.id)) !== original)
      throw new StoreError(
        'CHECKOUT_INTERFERENCE',
        'The exact original commit is no longer protected by its owned recovery reference. Preserve the checkout and recovery records.',
      );
    this.git(['cat-file', '-e', `${checkout.target.commit}^{commit}`]);
    if (checkout.target.branch) {
      this.git(['check-ref-format', checkout.target.branch]);
      if (
        checkout.create
          ? this.refOid(checkout.target.branch) !== null
          : this.refOid(checkout.target.branch) !== checkout.target.commit
      )
        throw new StoreError(
          'CHECKOUT_INTERFERENCE',
          'The checkout branch is missing, moved or already exists. No branch will be reset.',
        );
      const worktrees = this.git(['worktree', 'list', '--porcelain', '-z'])!.toString().split('\0');
      if (worktrees.includes(`branch ${checkout.target.branch}`))
        throw new StoreError(
          'CHECKOUT_INTERFERENCE',
          'The target branch is already checked out in a worktree. No branch will be taken over.',
        );
    }
    if (
      JSON.stringify(this.checkoutState(checkout.target.commit)) !== JSON.stringify(checkout.before)
    )
      throw new StoreError(
        'CHECKOUT_INTERFERENCE',
        'HEAD, index or working files changed since checkout preparation. No checkout was authorized.',
      );
  }
  checkoutOutcome(record: OperationRecord): 'applied' | 'not-applied' | 'refused' {
    const checkout = record.checkout!;
    const actual = this.checkoutState(checkout.target.commit);
    if (
      actual.branch === checkout.target.branch &&
      actual.commit === checkout.target.commit &&
      (!checkout.target.fingerprint || actual.fingerprint === checkout.target.fingerprint)
    )
      return 'applied';
    if (JSON.stringify(actual) === JSON.stringify(checkout.before)) return 'not-applied';
    return 'refused';
  }
  validateStash(record: OperationRecord) {
    const { prior, original } = record.stash!;
    const actual = this.checkoutState(undefined, 'inventory');
    if (actual.branch !== original.branch || actual.commit !== original.commit)
      throw new StoreError(
        'PRESERVATION_RECOVERY',
        'The original branch or HEAD changed. No stash/apply was authorized.',
      );
    if (record.kind === 'stash-push') {
      if (
        !matchesManifest(this, prior.manifest) ||
        this.refOid('refs/stash') !== prior.previousStash ||
        findPriorStash(this, prior, original.commit)
      )
        throw new StoreError(
          'PRESERVATION_RECOVERY',
          'Prior work or stash history changed. No new stash was authorized.',
        );
    } else {
      if (!prior.object || this.refOid(priorWorkRef(prior.stashId)) !== prior.object)
        throw new StoreError(
          'PRESERVATION_RECOVERY',
          'The exact prior-work protection is missing or moved. Retain all recovery records.',
        );
      verifyStash(this, prior, original.commit, prior.object);
      if (JSON.stringify(this.checkoutState()) !== JSON.stringify(prior.clean))
        throw new StoreError(
          'PRESERVATION_RECOVERY',
          'Prior-work apply requires the verified original clean checkout. Resolve the changed files and Retry recovery.',
        );
    }
  }
  stashOutcome(record: OperationRecord): 'applied' | 'not-applied' | 'refused' {
    const { prior, original } = record.stash!;
    const actual = this.checkoutState(undefined, 'inventory');
    if (actual.branch !== original.branch || actual.commit !== original.commit) return 'refused';
    if (record.kind === 'stash-apply') {
      if (!prior.object || this.refOid(priorWorkRef(prior.stashId)) !== prior.object)
        return 'refused';
      verifyStash(this, prior, original.commit, prior.object);
      if (matchesManifest(this, prior.manifest)) return 'applied';
      return JSON.stringify(this.checkoutState()) === JSON.stringify(prior.clean)
        ? 'not-applied'
        : 'refused';
    }
    const stash = findPriorStash(this, prior, original.commit);
    if (stash) {
      this.checkoutState();
      return 'applied';
    }
    return matchesManifest(this, prior.manifest) ? 'not-applied' : 'refused';
  }
  prepare(record: OperationRecord) {
    const expected = record.beforeOid ?? '0'.repeat(record.newOid.length);
    // --no-deref and compare-and-swap bind the effect to this exact app ref.
    const environment = { ...this.environment };
    if (record.kind === 'fetch') {
      // Installed Git keeps its configured HTTPS helpers / SSH access. API
      // tokens never enter this environment, the journal or the argument list.
      delete environment.GIT_CONFIG_NOSYSTEM;
      delete environment.GIT_CONFIG_GLOBAL;
      environment.GIT_TERMINAL_PROMPT = '0';
    }
    const command =
      record.kind === 'stash-push'
        ? ['stash', 'push', '--include-untracked', '-m', record.stash!.prior.marker]
        : record.kind === 'stash-apply'
          ? ['stash', 'apply', '--index', record.stash!.prior.object!]
          : record.kind === 'checkout'
            ? [
                '-c',
                'submodule.recurse=false',
                'checkout',
                '--no-overwrite-ignore',
                '--no-recurse-submodules',
                ...(record.checkout!.create
                  ? [
                      '-b',
                      record.checkout!.target.branch!.slice('refs/heads/'.length),
                      record.checkout!.target.commit,
                    ]
                  : record.checkout!.target.branch
                    ? [record.checkout!.target.branch.slice('refs/heads/'.length)]
                    : ['--detach', record.checkout!.target.commit]),
                '--',
              ]
            : record.kind === 'fetch'
              ? [
                  '-c',
                  'gc.auto=0',
                  '-c',
                  'maintenance.auto=false',
                  '-c',
                  'fetch.writeCommitGraph=false',
                  '-c',
                  'fetch.prune=false',
                  '-c',
                  'fetch.pruneTags=false',
                  '-c',
                  'submodule.recurse=false',
                  'fetch',
                  '--no-tags',
                  '--no-write-fetch-head',
                  '--no-recurse-submodules',
                  '--no-auto-gc',
                  '--refmap=',
                  '--',
                  record.fetch!.url,
                  `${record.fetch!.remoteRef}:${record.ref}`,
                ]
              : record.kind === 'delete-ref'
                ? ['update-ref', '--no-deref', '-d', record.ref, record.beforeOid!]
                : [
                    'update-ref',
                    '--no-deref',
                    '--create-reflog',
                    record.ref,
                    record.newOid,
                    expected,
                  ];
    return this.native.prepareChild(
      this.executable,
      [
        ...this.prefix,
        `--git-dir=${record.facts.gitDir}`,
        `--work-tree=${record.facts.worktree}`,
        ...command,
      ],
      this.location,
      {
        ...environment,
        GIT_DIR: record.facts.gitDir,
        GIT_COMMON_DIR: record.facts.commonGitDir,
        GIT_WORK_TREE: record.facts.worktree,
        GIT_INDEX_FILE: record.facts.index,
      },
      record.id,
    );
  }
}

export function assertOperationOwner(record: OperationRecord, lease: StoreLease) {
  if (
    record.storeId !== lease.storeId ||
    record.incarnation !== lease.incarnation ||
    record.fence !== lease.fence ||
    record.ownerToken !== lease.token ||
    record.scopeId !== lease.scopeId
  )
    throw new StoreError('STALE_LEASE', 'The operation belongs to another owner generation.');
}

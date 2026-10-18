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
  kind: 'update-ref';
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
export function oid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
export function operationFile(directory: string, id: string) {
  if (!uuid(id)) recovery('Operation identity is invalid.');
  return join(directory, `operation-${id}.json`);
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
    value.kind !== 'update-ref' ||
    !['prepared', 'armed', 'observed'].includes(String(value.phase)) ||
    !text(value.ref, 512) ||
    !oid(value.newOid) ||
    (value.beforeOid !== null && !oid(value.beforeOid)) ||
    value.beforeOid === value.newOid ||
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

// Only the typed update-ref builtin can reach the native child launcher.
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
  private git(args: string[], optional = false): Buffer | null {
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
  referenceStorage(ref: string, facts: RepositoryFacts) {
    return inspectReferenceStorage(facts.commonGitDir, ref, this.native);
  }
  sameReferenceStorage(record: OperationRecord, settled = false) {
    return sameReferenceStorage(
      record.storage,
      this.referenceStorage(record.ref, record.facts),
      settled,
    );
  }
  facts(): RepositoryFacts {
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
      digest.update(readFileSync(index));
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
  prepare(record: OperationRecord) {
    const expected = record.beforeOid ?? '0'.repeat(record.newOid.length);
    // --no-deref and compare-and-swap bind the effect to this exact app ref.
    return this.native.prepareChild(
      this.executable,
      [
        ...this.prefix,
        `--git-dir=${record.facts.gitDir}`,
        `--work-tree=${record.facts.worktree}`,
        'update-ref',
        '--no-deref',
        '--create-reflog',
        record.ref,
        record.newOid,
        expected,
      ],
      this.location,
      {
        ...this.environment,
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

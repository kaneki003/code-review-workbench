import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PriorWork, WorkFile, WorkManifest } from '../application/prior-work';
import { StoreError } from '../application/private-store';
import type { RepositoryOperation } from './repository-operation';
import { object, text, uuid } from './store-records';
import { assertPreservationPolicy, previewPreservedWork } from './git-attributes';

const oid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const unsupported = (detail: string): never => {
  throw new StoreError(
    'UNSUPPORTED_PRESERVATION',
    `${detail} Keep committed-source reading without switching.`,
  );
};
function safePath(path: string) {
  return (
    /^[a-zA-Z0-9_./ -]+$/.test(path) &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}
export function validPriorWork(value: unknown): value is PriorWork {
  function files(value: unknown): value is WorkFile[] {
    return (
      Array.isArray(value) &&
      value.length <= 10000 &&
      value.every(
        (file) =>
          object(file) &&
          text(file.path, 4096) &&
          safePath(file.path) &&
          ['100644', '100755', '120000', 'missing'].includes(String(file.mode)) &&
          (file.mode === 'missing' ? file.oid === null : oid(file.oid)),
      )
    );
  }
  function representation(manifest: Record<string, unknown>) {
    const value = manifest.representation;
    if (value === undefined) return true;
    if (
      !object(value) ||
      typeof value.attributes !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.attributes) ||
      !files(value.stored) ||
      !files(manifest.files)
    )
      return false;
    const raw = manifest.files;
    return (
      value.stored.every(
        (file) =>
          file.mode !== 'missing' &&
          raw.some(
            (original) =>
              original.path === file.path &&
              original.mode === file.mode &&
              original.oid !== file.oid,
          ),
      ) && new Set(value.stored.map((file) => file.path)).size === value.stored.length
    );
  }
  return (
    object(value) &&
    object(value.manifest) &&
    files(value.manifest.index) &&
    files(value.manifest.files) &&
    representation(value.manifest) &&
    Array.isArray(value.manifest.untracked) &&
    value.manifest.untracked.every((path) => text(path) && safePath(path)) &&
    uuid(value.stashId) &&
    uuid(value.applyId) &&
    value.marker === `code-review-workbench prior-work ${value.stashId}` &&
    (value.previousStash === null || oid(value.previousStash)) &&
    (value.object === null || oid(value.object)) &&
    (value.clean === null ||
      (object(value.clean) &&
        (value.clean.branch === null ||
          (text(value.clean.branch) && value.clean.branch.startsWith('refs/heads/'))) &&
        oid(value.clean.commit) &&
        text(value.clean.fingerprint, 64)))
  );
}
export function priorWorkRef(stashId: string) {
  if (!uuid(stashId)) unsupported('A preservation identity is required.');
  return `refs/code-review-workbench/recovery/${stashId}/prior-work`;
}
function entries(repository: RepositoryOperation, revision?: string): WorkFile[] {
  const raw = repository.git(
    revision ? ['ls-tree', '-r', '-z', revision] : ['ls-files', '--stage', '-z'],
  )!;
  return new TextDecoder('utf-8', { fatal: true })
    .decode(raw)
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match =
        /^(100644|100755|120000) (?:blob )?([a-f0-9]{40}|[a-f0-9]{64})(?: 0)?\t(.+)$/s.exec(entry);
      if (!match || /^0+$/.test(match[2]!))
        return unsupported('An index/tree representation is unsupported.');
      return { path: match[3]!, mode: match[1] as WorkFile['mode'], oid: match[2]! };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function rawManifest(repository: RepositoryOperation): WorkManifest {
  const before = repository.checkoutState(undefined, 'inventory');
  const facts = repository.facts();
  const index = entries(repository),
    head = entries(repository, before.commit);
  if (
    [
      ...repository
        .git(['ls-files', '--debug', '-z'])!
        .toString()
        .matchAll(/flags: ([0-9a-f]+)/g),
    ].some((match) => match[1] !== '0')
  )
    unsupported('Intent-to-add or special index flags require validated preservation support.');
  const untracked = new TextDecoder('utf-8', { fatal: true })
    .decode(repository.git(['ls-files', '--others', '--exclude-standard', '-z'])!)
    .split('\0')
    .filter(Boolean)
    .sort();
  const paths = [
    ...new Set([...head.map((file) => file.path), ...index.map((file) => file.path), ...untracked]),
  ].sort();
  if (paths.length > 10000)
    throw new StoreError(
      'REPOSITORY_LIMIT',
      'Preservation inventory exceeds the current 10,000-file bound.',
    );
  if (
    paths.some((path) => !safePath(path)) ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
  )
    unsupported('Unusual paths or case collisions require validated preservation support.');
  let bytes = 0;
  const inventory = paths.map((path) => {
    let parent = dirname(path);
    while (parent !== '.') {
      try {
        if (lstatSync(join(facts.worktree, parent)).isSymbolicLink())
          unsupported('A path crosses a symbolic-link directory.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      parent = dirname(parent);
    }
    const absolute = join(facts.worktree, path);
    let metadata;
    try {
      metadata = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, absolute, metadata: null };
    }
    if (!metadata.isFile())
      unsupported(
        'Symbolic links, nested repositories and special files require validated preservation support.',
      );
    if (
      process.platform !== 'win32' &&
      (metadata.mode & 0o777) !== (metadata.mode & 0o111 ? 0o755 : 0o644)
    )
      unsupported('Nonstandard file permissions require validated preservation support.');
    bytes += metadata.size;
    if (bytes > 128 * 1024 * 1024)
      throw new StoreError(
        'REPOSITORY_LIMIT',
        'Preservation inventory exceeds the current 128 MiB bound.',
      );
    return { path, absolute, metadata };
  });
  const files = inventory
    .map(({ path, absolute, metadata }): WorkFile => {
      if (!metadata) return { path, mode: 'missing', oid: null };
      const content = readFileSync(absolute);
      return {
        path,
        mode: process.platform !== 'win32' && metadata.mode & 0o111 ? '100755' : '100644',
        oid: createHash(before.commit.length === 40 ? 'sha1' : 'sha256')
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest('hex'),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  // Symlink index entries also require a faithful platform fixture before enabling.
  if (index.some((file) => file.mode === '120000'))
    unsupported('Symbolic links require validated preservation support.');
  const diskByPath = new Map(files.map((file) => [file.path, file]));
  if (
    repository.git(['config', '--get', 'core.filemode'], true)?.toString().trim() === 'false' &&
    index.some((file) => {
      const disk = diskByPath.get(file.path);
      return disk && disk.mode !== 'missing' && disk.mode !== file.mode;
    })
  )
    unsupported('Untracked executable-mode changes require validated preservation support.');
  if (!repository.sameFacts(facts))
    throw new StoreError(
      'REPOSITORY_CHANGED',
      'Files or index changed during preservation inventory. Retry normal saving.',
    );
  return { index, files, untracked };
}
export function workManifest(repository: RepositoryOperation): WorkManifest {
  const manifest = rawManifest(repository);
  const facts = repository.facts();
  const representation = previewPreservedWork(repository, manifest, entries(repository, 'HEAD'));
  assertPreservationPolicy(repository, { ...manifest, representation });
  if (!repository.sameFacts(facts))
    throw new StoreError(
      'REPOSITORY_CHANGED',
      'Files or Git attributes changed during conversion preview. Retry saving.',
    );
  return { ...manifest, representation };
}
export function matchesManifest(repository: RepositoryOperation, expected: WorkManifest) {
  return same(rawManifest(repository), {
    index: expected.index,
    files: expected.files,
    untracked: expected.untracked,
  });
}
export function verifyStash(
  repository: RepositoryOperation,
  prior: PriorWork,
  commit: string,
  stash: string,
) {
  const parents = repository
    .git(['rev-list', '--parents', '-n', '1', stash])!
    .toString()
    .trim()
    .split(' ');
  if (
    ![3, 4].includes(parents.length) ||
    (prior.manifest.untracked.length > 0 && parents.length !== 4) ||
    parents[1] !== commit ||
    !repository
      .git(['show', '-s', '--format=%s', stash])!
      .toString()
      .trim()
      .endsWith(`: ${prior.marker}`)
  )
    throw new StoreError(
      'PRESERVATION_RECOVERY',
      'The operation-tagged stash has unexpected ancestry or identity. Retain it and Retry recovery.',
    );
  const tracked = new Set(prior.manifest.index.map((file) => file.path));
  const stored = new Map(prior.manifest.representation?.stored.map((file) => [file.path, file]));
  const files = prior.manifest.files.map((file) => stored.get(file.path) ?? file);
  const disk = files.filter((file) => tracked.has(file.path) && file.mode !== 'missing');
  const newPaths = new Set(prior.manifest.untracked);
  const untracked = files.filter((file) => newPaths.has(file.path));
  if (
    !same(entries(repository, `${stash}^2`), prior.manifest.index) ||
    !same(entries(repository, stash), disk) ||
    (parents.length === 4 && !same(entries(repository, `${stash}^3`), untracked))
  )
    throw new StoreError(
      'PRESERVATION_RECOVERY',
      'Stash content, types or index differ from the saved prior-work manifest. Keep all protection and use recovery.',
    );
}
export function findPriorStash(
  repository: RepositoryOperation,
  prior: PriorWork,
  commit: string,
): string | null {
  const raw =
    repository.refOid('refs/stash') === null
      ? ''
      : repository.git(['reflog', 'show', '--format=%H%x00%gs', 'refs/stash'])!.toString();
  const matches = [
    ...new Set(
      raw
        .split('\n')
        .filter((line) => line.endsWith(`: ${prior.marker}`))
        .map((line) => line.split('\0')[0]!),
    ),
  ];
  if (matches.length > 1)
    throw new StoreError(
      'PRESERVATION_RECOVERY',
      'Several operation-tagged stash objects were found. Keep them for manual recovery.',
    );
  const stash = prior.object ?? matches[0] ?? null;
  if (stash) verifyStash(repository, prior, commit, stash);
  return stash;
}

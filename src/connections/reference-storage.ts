import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { StoreError } from '../application/private-store';
import { object, text, type NativeStore } from './store-records';

export interface ReferencePath {
  path: string;
  kind: 'directory' | 'ref' | 'reflog';
  identity: string | null;
}

export function referencePaths(value: unknown): value is ReferencePath[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 512 &&
    value.every(
      (entry) =>
        object(entry) &&
        text(entry.path) &&
        isAbsolute(entry.path) &&
        ['directory', 'ref', 'reflog'].includes(String(entry.kind)) &&
        (entry.identity === null || text(entry.identity, 128)),
    )
  );
}

// Git follows intermediate directories and appends to an existing reflog.
// --no-deref alone therefore cannot bind an update to the recorded Git root.
export function inspectReferenceStorage(
  commonGitDir: string,
  ref: string,
  native: NativeStore,
): ReferencePath[] {
  const paths = new Map<string, ReferencePath['kind']>();
  for (const [leaf, kind] of [
    [join(commonGitDir, ref), 'ref'],
    [join(commonGitDir, 'logs', ref), 'reflog'],
  ] as const) {
    const parents: string[] = [];
    for (let parent = dirname(leaf); parent !== commonGitDir; parent = dirname(parent)) {
      if (parent === dirname(parent))
        throw new StoreError('INVALID_OPERATION', 'The reference escapes its Git directory.');
      parents.unshift(parent);
    }
    for (const parent of parents) paths.set(parent, 'directory');
    paths.set(leaf, kind);
  }
  return [...paths].map(([path, kind]) => {
    let file;
    try {
      file = lstatSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, kind, identity: null };
    }
    if (
      file.isSymbolicLink() ||
      (kind === 'directory' ? !file.isDirectory() : !file.isFile() || file.nlink !== 1n) ||
      realpathSync(path) !== path
    )
      throw new StoreError(
        'INVALID_OPERATION',
        'Reference and log paths must be canonical, without redirects or shared file links.',
      );
    if (kind === 'directory') native.assertLocalDirectory(path);
    return { path, kind, identity: `${file.dev}:${file.ino}` };
  });
}

export function sameReferenceStorage(
  expected: ReferencePath[],
  current: ReferencePath[],
  settled: boolean,
  removingOwned = false,
) {
  return (
    expected.length === current.length &&
    expected.every((before, index) => {
      const after = current[index]!;
      if (before.path !== after.path || before.kind !== after.kind) return false;
      if (!settled) return before.identity === after.identity;
      if (
        removingOwned &&
        after.identity === null &&
        /[\\/]refs[\\/](?:heads[\\/])?code-review-workbench(?:[\\/]|$)/.test(before.path)
      )
        return true;
      // Git may create missing parents/reflogs and atomically replace the ref.
      // Existing directories and an appended reflog must retain their identity.
      return (
        before.kind === 'ref' || before.identity === null || before.identity === after.identity
      );
    })
  );
}

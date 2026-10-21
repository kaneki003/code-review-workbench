import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StoreError } from '../application/private-store';
import type { WorkFile, WorkManifest } from '../application/prior-work';
import type { RepositoryOperation } from './repository-operation';

type ReadGit = (args: string[], input?: Buffer) => Buffer;
const conversionConfig =
  '^(core\\.(autocrlf|eol|safecrlf|attributesfile|checkroundtripencoding)|attr\\.tree|filter\\..*|merge\\.(default|.*\\.driver)|diff\\.(external|.*\\.(command|textconv)))$';

function unsupported(detail: string): never {
  throw new StoreError(
    'UNSUPPORTED_PRESERVATION',
    `${detail} Keep committed-source reading without switching.`,
  );
}

function config(repository: RepositoryOperation) {
  return (
    repository.git(['config', '-z', '--get-regexp', conversionConfig], true) ?? Buffer.alloc(0)
  );
}

function attributes(paths: string[], read: ReadGit, cached = false) {
  if (!paths.length) return Buffer.alloc(0);
  return read(
    ['check-attr', '-z', '--stdin', '--all', ...(cached ? ['--cached'] : [])],
    Buffer.from(`${paths.join('\0')}\0`),
  );
}

export function blobOid(content: Buffer, format: string) {
  return createHash(format.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** Effective rules, including default global/system attributes and Git's EOL fallback. */
export function conversionFingerprint(
  repository: RepositoryOperation,
  paths: string[],
  read: ReadGit = (args, input) => repository.git(args, false, input)!,
  cached = false,
) {
  return createHash('sha256')
    .update(config(repository))
    .update(attributes(paths, read, cached))
    .digest('hex');
}

export function assertPreservationPolicy(
  repository: RepositoryOperation,
  manifest: WorkManifest,
  originalRules = false,
) {
  const paths = manifest.files.map((file) => file.path);
  const inspect = (read?: ReadGit, cached = false) => {
    if (!manifest.representation && assertSupportedAttributes(repository, paths, read, cached))
      throw new StoreError(
        'PRESERVATION_RECOVERY',
        'This older backup has no conversion-policy record. Restore the original nonconverting Git rules before Retry; the backup is retained.',
      );
    return conversionFingerprint(repository, paths, read, cached);
  };
  let policy: string;
  if (originalRules) {
    const preview = new ConversionPreview(repository);
    try {
      preview.seed(manifest.index);
      policy = inspect(preview.read, true);
    } finally {
      preview.dispose();
    }
  } else policy = inspect();
  if (manifest.representation && manifest.representation.attributes !== policy)
    throw new StoreError(
      'PRESERVATION_RECOVERY',
      'Git attributes or line-ending configuration changed. Restore the original rules before Retry; the prior-work backup is retained.',
    );
}

export function assertSupportedAttributes(
  repository: RepositoryOperation,
  paths: string[],
  read: ReadGit = (args, input) => repository.git(args, false, input)!,
  cached = false,
) {
  let converts = false;
  // These helpers can execute even when the current content merge is trivial.
  for (const entry of config(repository).toString().split('\0').filter(Boolean)) {
    const key = entry.split('\n', 1)[0]!;
    if (/^(filter\.|merge\.|diff\.|attr\.tree$)/.test(key))
      unsupported(`Configured Git conversion, diff or merge helpers (${key}) are unsupported.`);
    if (key === 'core.autocrlf' && !/^(false|no|off|0)$/i.test(entry.slice(key.length + 1)))
      converts = true;
  }
  const fields = attributes(paths, read, cached).toString().split('\0');
  fields.pop();
  if (fields.length % 3) unsupported('Git returned incomplete attribute information.');
  for (let offset = 0; offset < fields.length; offset += 3) {
    const [path, name, value] = fields.slice(offset, offset + 3) as [string, string, string];
    if (value === 'unset' || value === 'unspecified') continue;
    if (['text', 'eol', 'crlf'].includes(name)) converts = true;
    if (
      ['filter', 'ident', 'working-tree-encoding'].includes(name) ||
      (name === 'text' && !['set', 'auto'].includes(value)) ||
      (name === 'eol' && !['lf', 'crlf'].includes(value)) ||
      (name === 'crlf' && !['set', 'input'].includes(value)) ||
      (name === 'merge' && !['set', 'text', 'binary', 'union'].includes(value))
    )
      unsupported(`${path}: Git attribute ${name}=${value} requires unsupported conversion.`);
  }
  return converts;
}

function indexEntries(raw: Buffer): WorkFile[] {
  return raw
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/s.exec(entry);
      if (!match) unsupported('The conversion preview found an unsupported index entry.');
      return { path: match[3]!, mode: match[1] as WorkFile['mode'], oid: match[2]! };
    });
}

/** All writes are confined to a fresh scratch index/object directory. */
class ConversionPreview {
  private readonly directory = realpathSync(mkdtempSync(join(tmpdir(), 'crw-attributes-')));
  private readonly environment: Record<string, string>;
  constructor(private readonly repository: RepositoryOperation) {
    try {
      const objects = repository
        .git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])!
        .toString()
        .trim();
      mkdirSync(join(this.directory, 'objects'), { mode: 0o700 });
      this.environment = {
        ...repository.environment,
        GIT_INDEX_FILE: join(this.directory, 'index'),
        GIT_OBJECT_DIRECTORY: join(this.directory, 'objects'),
        // Git uses C-style quoting for a single alternate, including Windows paths.
        GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
      };
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  read: ReadGit = (args, input) => {
    try {
      return execFileSync(this.repository.executable, this.repository.readArguments(args), {
        env: this.environment,
        input,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 129 * 1024 * 1024,
        windowsHide: true,
      });
    } catch {
      throw new StoreError(
        'GIT_REPRESENTATION',
        'Git could not complete the bounded conversion preview. Keep the current work and Retry.',
      );
    }
  };
  seed(files: WorkFile[]) {
    this.read(['read-tree', '--empty']);
    if (files.length)
      this.read(
        ['update-index', '-z', '--index-info'],
        Buffer.from(files.map((file) => `${file.mode} ${file.oid}\t${file.path}\0`).join('')),
      );
  }
  store(paths: string[]) {
    if (paths.length)
      this.read(
        ['update-index', '--add', '--remove', '-z', '--stdin'],
        Buffer.from(`${paths.join('\0')}\0`),
      );
    return indexEntries(this.read(['ls-files', '--stage', '-z']));
  }
  checkout(files: WorkFile[]) {
    if (!files.length) return [];
    if (
      files.some(
        (file) =>
          file.path.startsWith('/') ||
          file.path.split('/').some((part) => !part || part === '.' || part === '..'),
      )
    )
      unsupported('An unsafe checkout-preview path is unsupported.');
    const sizes = this.read(
      ['cat-file', '--batch-check=%(objectsize)'],
      Buffer.from(files.map((file) => `${file.oid}\n`).join('')),
    )
      .toString()
      .trim()
      .split('\n');
    if (
      sizes.length !== files.length ||
      sizes.some((size) => !/^\d+$/.test(size)) ||
      sizes.reduce((total, size) => total + Number(size), 0) > 128 * 1024 * 1024
    )
      unsupported('Checkout-preview objects exceed the 128 MiB inventory bound.');
    const destination = mkdtempSync(join(this.directory, 'checkout-'));
    this.read(
      ['checkout-index', `--prefix=${destination}/`, '-z', '--stdin'],
      Buffer.from(`${files.map((file) => file.path).join('\0')}\0`),
    );
    let bytes = 0;
    return files.map((file) => {
      const path = join(destination, file.path);
      const info = lstatSync(path);
      bytes += info.size;
      if (!info.isFile() || bytes > 128 * 1024 * 1024)
        unsupported('Checkout-preview files exceed the supported representation or 128 MiB bound.');
      return { ...file, oid: blobOid(readFileSync(path), file.oid!) };
    });
  }
  dispose() {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Materialize only in scratch storage, using Git's native checkout conversion. */
export function checkoutFiles(repository: RepositoryOperation, files: WorkFile[]) {
  if (!files.length) return [];
  const preview = new ConversionPreview(repository);
  try {
    preview.seed(files);
    return preview.checkout(files);
  } finally {
    preview.dispose();
  }
}

export function assertCheckoutAttributes(repository: RepositoryOperation, target: string) {
  const preview = new ConversionPreview(repository);
  try {
    preview.read(['read-tree', target]);
    const paths = preview.read(['ls-files', '-z']).toString().split('\0').filter(Boolean);
    if (paths.length > 10000) unsupported('Target attribute inventory exceeds 10,000 paths.');
    assertSupportedAttributes(repository, paths, preview.read, true);
    // Checkout can fall back to working-tree attribute files absent from the
    // target index, including ignored files affecting only newly added paths.
    assertSupportedAttributes(repository, paths, preview.read);
  } finally {
    preview.dispose();
  }
}

export function previewPreservedWork(
  repository: RepositoryOperation,
  manifest: WorkManifest,
  head: WorkFile[],
): NonNullable<WorkManifest['representation']> {
  const paths = manifest.files.map((file) => file.path);
  const policy = conversionFingerprint(repository, paths);
  const converts = assertSupportedAttributes(repository, paths);
  assertSupportedAttributes(repository, paths, undefined, true);
  const preview = converts ? new ConversionPreview(repository) : undefined;
  try {
    // Rebuild from staged blob identities, deliberately excluding all stat cache fields.
    preview?.seed(manifest.index);
    const attributePaths = new Set<string>();
    const location = repository.git(['rev-parse', '--show-toplevel'])!.toString().trim();
    for (const path of paths) {
      if (path.split('/').at(-1) === '.gitattributes') attributePaths.add(path);
      let directory = dirname(path);
      while (true) {
        const attribute = directory === '.' ? '.gitattributes' : `${directory}/.gitattributes`;
        if (existsSync(join(location, attribute))) attributePaths.add(attribute);
        if (directory === '.') break;
        directory = dirname(directory);
      }
    }
    const originalAttributes: WorkFile[] = [];
    for (const path of attributePaths) {
      const original = head.find((file) => file.path === path);
      const staged = manifest.index.find((file) => file.path === path);
      if (!original || !staged || JSON.stringify(original) !== JSON.stringify(staged))
        unsupported(
          `${path}: unfinished attribute-file changes require separate preservation support.`,
        );
      originalAttributes.push(original);
    }
    const disk = new Map(manifest.files.map((file) => [file.path, file]));
    for (const expected of preview?.checkout(originalAttributes) ?? originalAttributes) {
      if (JSON.stringify(disk.get(expected.path)) !== JSON.stringify(expected))
        unsupported(
          `${expected.path}: unfinished attribute-file changes require separate preservation support.`,
        );
    }
    if (!preview) return { attributes: policy, stored: [] };
    const tracked = preview.store(manifest.index.map((file) => file.path));
    const renderedTracked = preview.checkout(tracked);
    preview.seed([]);
    const untracked = preview.store(manifest.untracked);
    const renderedUntracked = preview.checkout(untracked);
    for (const rendered of [...renderedTracked, ...renderedUntracked]) {
      if (JSON.stringify(disk.get(rendered.path)) !== JSON.stringify(rendered))
        unsupported(
          `${rendered.path}: Git's line-ending conversion cannot restore the original bytes exactly.`,
        );
    }
    return {
      attributes: policy,
      stored: [...tracked, ...untracked].filter((file) => file.oid !== disk.get(file.path)?.oid),
    };
  } finally {
    preview?.dispose();
  }
}

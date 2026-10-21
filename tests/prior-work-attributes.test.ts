import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkoutEditors, fixture, integrationTimeout } from './fixtures/committed-review';

afterEach(() => vi.unstubAllEnvs());

async function review(context: Awaited<ReturnType<typeof fixture>>) {
  const manager = context.manager(
    undefined,
    undefined,
    undefined,
    checkoutEditors(context.location),
  );
  await manager.openPullRequestOverview(context.pullRequest.url);
  const source = await manager.inspectPullRequestSource('3001', 20);
  if (source.status !== 'ready') throw new Error(source.detail);
  return { manager, source: source.source };
}

// Frozen protocol-1 identity format from before attribute support. Directory
// identities vary per fixture, so a static digest cannot represent an old record.
async function protocolOneFingerprint(location: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', location, ...args]);
  const [worktree, common, index, admin] = git(
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
    '--git-path',
    'index',
    '--absolute-git-dir',
  )
    .toString()
    .trimEnd()
    .split(/\r?\n/)
    .map(normalize) as [string, string, string, string];
  const scopes = await Promise.all(
    [worktree, common].map(async (path) => {
      const info = await stat(path, { bigint: true });
      return `${info.dev}:${info.ino}:${path}`;
    }),
  );
  const info = await stat(admin, { bigint: true });
  const digest = createHash('sha256').update(JSON.stringify(scopes.sort()));
  digest.update(`${info.dev}:${info.ino}:${admin}:${index}`);
  digest.update(git('symbolic-ref', '-q', 'HEAD'));
  digest.update(git('rev-parse', '--verify', '--quiet', 'HEAD'));
  digest.update(git('ls-files', '--stage', '-z'));
  const paths = [
    ...new Set(
      git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        .toString()
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  for (const path of paths) {
    digest.update(path).update('\0');
    digest.update(String((await stat(join(worktree, path), { bigint: true })).mode));
    digest.update(await readFile(join(worktree, path)));
  }
  return digest.digest('hex');
}

test.each(['clean', 'unfinished'])(
  'protocol-1 identities remain compatible when reopening %s reviews',
  async (state) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    if (state === 'unfinished')
      await writeFile(join(context.location, 'worker.ts'), 'unfinished previous work\n');
    const { manager, source } = await review(context);
    const original = await protocolOneFingerprint(context.location);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    expect((await manager.readCheckoutReview())?.original.fingerprint).toBe(original);
    await manager.releasePrivateStore();
    const reopened = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    const restored = await reopened.recoverPullRequestCheckout('restore');
    expect(restored, restored.detail).toMatchObject({ status: 'complete' });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      state === 'unfinished' ? 'unfinished previous work\n' : 'export const count = 1;\n',
    );
    await reopened.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'ignored working-tree attributes affecting target-only files refuse before clean entry',
  async () => {
    const context = await fixture();
    await writeFile(join(context.location, 'target.new'), 'target UTF-8 bytes\n');
    await context.publishHead();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.git', 'info', 'exclude'), '.gitattributes\n');
    await writeFile(
      join(context.location, '.gitattributes'),
      '*.new working-tree-encoding=UTF-16\n',
    );
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'blocked' });
    expect(entered.detail).toMatch(/target.new.*working-tree-encoding=UTF-16/);
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('stash', 'list')).toBe('');
    expect(await manager.readCheckoutReview()).toBeUndefined();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['true', 'yes'])(
  'core.autocrlf=%s preserves ordinary CRLF files without an attributes file',
  async (value) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    context.git('config', 'core.autocrlf', value);
    await writeFile(join(context.location, 'delete.py'), 'print("old")\r\n');
    await writeFile(join(context.location, 'worker.ts'), 'staged CRLF\r\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'unstaged CRLF\r\n');
    await writeFile(join(context.location, 'notes.txt'), 'untracked CRLF\r\n');
    const index = context.git('ls-files', '--stage', '-z');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('unstaged CRLF\r\n');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('untracked CRLF\r\n');
    expect(await readFile(join(context.location, 'delete.py'), 'utf8')).toBe('print("old")\r\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'attribute conversion previews preserve files larger than the inspection output buffer',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), '* text=auto eol=lf\n');
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use LF');
    const bytes = Buffer.alloc(9 * 1024 * 1024, 97);
    await writeFile(join(context.location, 'large.txt'), bytes);
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'large.txt'))).toEqual(bytes);
    await manager.releasePrivateStore();
  },
  Math.max(integrationTimeout, 60_000),
);

test.each(['filter=lfs', 'ident', 'working-tree-encoding=UTF-16', 'merge=custom'])(
  'unsupported %s rules refuse without stashing or switching',
  async (rule) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), `*.ts ${rule}\n`);
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Configure unsupported attributes');
    await writeFile(join(context.location, 'worker.ts'), 'keep these bytes\n');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'blocked' });
    expect(entered.detail).toContain(rule);
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('keep these bytes\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['merge.custom.driver', 'merge.default', 'diff.custom.textconv', 'diff.external'])(
  'configured %s cannot execute through checkout or stash',
  async (key) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    context.git('config', key, 'crw-must-not-run');
    await writeFile(join(context.location, 'worker.ts'), 'keep these bytes\n');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'blocked' });
    expect(entered.detail).toContain(key);
    expect(context.git('stash', 'list')).toBe('');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('keep these bytes\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['repository info', 'configured global file', 'default global file'])(
  '%s attributes support exact CRLF preservation',
  async (source) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    let path = join(context.location, '.git', 'info', 'attributes');
    if (source === 'configured global file') {
      path = join(context.directory, 'custom attributes');
      context.git('config', 'core.attributesFile', path);
    } else if (source === 'default global file') {
      const config = join(context.directory, 'config');
      await mkdir(join(config, 'git'), { recursive: true });
      path = join(config, 'git', 'attributes');
      vi.stubEnv('XDG_CONFIG_HOME', config);
    }
    await writeFile(path, '*.ts text eol=crlf\n*.txt text eol=crlf\n');
    await writeFile(join(context.location, 'worker.ts'), 'staged CRLF\r\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'disk CRLF\r\n');
    await writeFile(join(context.location, 'notes.txt'), 'new CRLF\r\n');
    const index = context.git('ls-files', '--stage', '-z');
    const { manager, source: committed } = await review(context);
    const entered = await manager.enterPullRequestCheckout(committed.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('disk CRLF\r\n');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new CRLF\r\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['staged index', 'original commit'])(
  'legacy CRLF stored in the %s survives text=auto preservation',
  async (legacy) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), '*.ts text=auto eol=lf\n');
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use automatic LF normalization');
    const worker = join(context.location, 'worker.ts');
    await writeFile(worker, 'legacy staged CRLF\r\n');
    const raw = context.git('hash-object', '-w', '--no-filters', 'worker.ts');
    context.git('update-index', '--cacheinfo', `100644,${raw},worker.ts`);
    if (legacy === 'original commit') context.git('commit', '-m', 'Retain legacy CRLF blob');
    await writeFile(worker, 'unfinished legacy CRLF\r\n');
    const index = context.git('ls-files', '--stage', '-z');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(worker, 'utf8')).toBe('unfinished legacy CRLF\r\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['stash-push.effect.after', 'stash-apply.effect.after'])(
  'Recover restores exact CRLF work after interruption at %s',
  async (boundary) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(
      join(context.location, '.gitattributes'),
      '*.ts text eol=crlf\n*.txt text eol=crlf\n',
    );
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use CRLF');
    await writeFile(join(context.location, 'worker.ts'), 'staged before interruption\r\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'unstaged before interruption\r\n');
    await writeFile(join(context.location, 'notes.txt'), 'new before interruption\r\n');
    const index = context.git('ls-files', '--stage', '-z');
    const first = await review(context);
    await first.manager.dispose();
    const { child, result } = await context.interruptedInspector(
      first.source.id,
      boundary,
      boundary.startsWith('stash-apply') ? 'exit' : undefined,
    );
    expect(result.result).toMatchObject({ status: 'recovery' });
    const stash = context.git('rev-parse', 'refs/stash');
    const stopped = once(child, 'exit');
    child.kill('SIGKILL');
    await stopped;
    const recovered = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    const restored = await recovered.recoverPullRequestCheckout('restore');
    expect(restored, restored.detail).toMatchObject({ status: 'complete' });
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(context.git('stash', 'list', '--format=%H')).toBe(stash);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unstaged before interruption\r\n',
    );
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe(
      'new before interruption\r\n',
    );
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a PR with different supported attributes enters with CRLF and restores the original LF rules',
  async () => {
    const context = await fixture();
    await writeFile(join(context.location, '.gitattributes'), '*.ts text eol=crlf\n');
    await context.publishHead();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), '* text=auto eol=lf\n');
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use LF original checkout');
    await writeFile(join(context.location, 'worker.ts'), 'unfinished LF\n');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'export const count = 2;\r\n// committed\r\n',
    );
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('unfinished LF\n');
    expect(await readFile(join(context.location, '.gitattributes'), 'utf8')).toBe(
      '* text=auto eol=lf\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'unsupported target-only attributes refuse before prior work is stashed',
  async () => {
    const context = await fixture();
    await writeFile(join(context.location, '.gitattributes'), '*.ts filter=lfs\n');
    await context.publishHead();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'unfinished original bytes\n');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'blocked' });
    expect(entered.detail).toMatch(/worker.ts.*filter=lfs/);
    expect(context.git('stash', 'list')).toBe('');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unfinished original bytes\n',
    );
    expect(await manager.readCheckoutReview()).toBeUndefined();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  { rule: 'lf', bytes: 'line one\r\nline two\r\n' },
  { rule: 'crlf', bytes: 'line one\nline two\n' },
  { rule: 'crlf', bytes: 'line one\r\nline two\n' },
])(
  'irreversible $rule conversion refuses before stash and retains exact disk and index bytes ($bytes)',
  async ({ rule, bytes }) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), `*.ts text eol=${rule}\n`);
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Set line endings');
    await writeFile(join(context.location, 'worker.ts'), bytes);
    const index = context.git('ls-files', '--stage', '-z');
    const { manager, source } = await review(context);
    const result = await manager.enterPullRequestCheckout(source.id);
    expect(result, result.detail).toMatchObject({ status: 'blocked' });
    expect(result.detail).toMatch(/worker.ts.*cannot restore the original bytes/);
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(bytes);
    expect(await manager.readCheckoutReview()).toBeUndefined();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['staged', 'unstaged', 'new', 'deleted'])(
  '%s attribute-file changes refuse before preservation',
  async (state) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    const attributes = join(context.location, '.gitattributes');
    if (state !== 'new') {
      await writeFile(attributes, '* text=auto eol=lf\n');
      context.git('add', '.gitattributes');
      context.git('commit', '-m', 'Use LF');
    }
    if (state === 'deleted') await rm(attributes);
    else await writeFile(attributes, '* text=auto eol=lf\n# unfinished rules\n');
    if (state === 'staged') context.git('add', '.gitattributes');
    await writeFile(join(context.location, 'worker.ts'), 'unfinished LF\n');
    const index = context.git('ls-files', '--stage', '-z');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'blocked' });
    expect(entered.detail).toMatch(/gitattributes.*unfinished attribute-file/);
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('unfinished LF\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a clean CRLF checkout returns without fabricating a prior-work stash',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), '*.ts text eol=crlf\n');
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use CRLF');
    await rm(join(context.location, 'worker.ts'));
    context.git('checkout-index', '--index', '--force', '--', 'worker.ts');
    expect(context.git('status', '--porcelain=v1'), context.git('ls-files', '--eol')).toBe('');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    expect(entered.review?.priorWork).toBeUndefined();
    expect(context.git('stash', 'list')).toBe('');
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'export const count = 1;\r\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'nested overrides and binary exclusions preserve their independent byte representations',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await mkdir(join(context.location, 'nested'));
    await writeFile(join(context.location, '.gitattributes'), '* text=auto eol=lf\n*.bin -text\n');
    await writeFile(join(context.location, 'nested', '.gitattributes'), '*.txt text eol=crlf\n');
    context.git('add', '.gitattributes', 'nested/.gitattributes');
    context.git('commit', '-m', 'Configure nested endings and binary files');
    await writeFile(join(context.location, 'nested', 'notes.txt'), 'new CRLF\r\n');
    const binary = Buffer.from([0, 128, 255, 13, 10, 10, 0]);
    await writeFile(join(context.location, 'image.bin'), binary);
    await writeFile(join(context.location, 'worker.ts'), 'unfinished LF\n');
    const { manager, source } = await review(context);
    const entered = await manager.enterPullRequestCheckout(source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'nested', 'notes.txt'), 'utf8')).toBe(
      'new CRLF\r\n',
    );
    expect(await readFile(join(context.location, 'image.bin'))).toEqual(binary);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Exit retains the PR checkout and backup when external attribute rules change',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), '*.ts text eol=crlf\n');
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use CRLF working files');
    await writeFile(join(context.location, 'worker.ts'), 'unfinished CRLF\r\n');
    const manager = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const branch = context.git('symbolic-ref', 'HEAD');
    const stash = entered.review!.priorWork!.object!;
    await writeFile(join(context.location, '.git', 'info', 'attributes'), '* -text\n');
    const exited = await manager.exitPullRequestCheckout();
    expect(exited.status).toBe('recovery');
    expect(context.git('symbolic-ref', 'HEAD')).toBe(branch);
    expect(context.git('rev-parse', 'refs/stash')).toBe(stash);
    await writeFile(join(context.location, '.git', 'info', 'attributes'), '');
    const restored = await manager.recoverPullRequestCheckout('restore');
    expect(restored, restored.detail).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('unfinished CRLF\r\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Enter and Exit restore CRLF staging, unstaged bytes and untracked bytes under stable rules',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(
      join(context.location, '.gitattributes'),
      '*.ts text eol=crlf\n*.txt text eol=crlf\n',
    );
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use CRLF working files');
    await writeFile(join(context.location, 'worker.ts'), 'staged CRLF work\r\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'unstaged CRLF work 🐈\r\n');
    await writeFile(join(context.location, 'notes.txt'), 'new CRLF work\r\n');
    const index = context.git('ls-files', '--stage', '-z');
    const manager = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unstaged CRLF work 🐈\r\n',
    );
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new CRLF work\r\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Enter and Exit preserve separate staging and disk bytes with the repository LF attributes',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.gitattributes'), '* text=auto eol=lf\n');
    context.git('add', '.gitattributes');
    context.git('commit', '-m', 'Use LF text checkouts');
    const original = context.git('rev-parse', 'HEAD');
    await writeFile(join(context.location, 'worker.ts'), 'staged LF work\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'unstaged LF work 🐈\n');
    await writeFile(join(context.location, 'notes.txt'), 'new LF work\n');
    const index = context.git('ls-files', '--stage', '-z');
    const manager = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);

    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, entered.detail).toMatchObject({ status: 'active' });
    expect(context.git('status', '--porcelain=v1')).toBe('');
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, exited.detail).toMatchObject({ status: 'complete' });
    expect(context.git('rev-parse', 'HEAD')).toBe(original);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unstaged LF work 🐈\n',
    );
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new LF work\n');
    expect(await readFile(join(context.location, '.gitattributes'), 'utf8')).toBe(
      '* text=auto eol=lf\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

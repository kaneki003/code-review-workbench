import { expect, test } from 'vitest';
import {
  readFile,
  writeFile,
  mkdir,
  symlink,
  rename,
  chmod,
  stat,
  truncate,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, integrationTimeout, checkoutEditors } from './fixtures/committed-review';

test(
  'preservation bounds retained ignored files removed from the index before reading their bytes',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    context.git('rm', '--cached', 'worker.ts');
    await writeFile(join(context.location, '.git', 'info', 'exclude'), 'worker.ts\n');
    await truncate(join(context.location, 'worker.ts'), 128 * 1024 * 1024 + 1);
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
    const result = await manager.enterPullRequestCheckout(source.source.id);
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.detail).toContain('128 MiB');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect((await stat(join(context.location, 'worker.ts'))).size).toBe(128 * 1024 * 1024 + 1);
    expect(context.git('stash', 'list')).toBe('');
    expect(await manager.readCheckoutReview()).toBeUndefined();
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'entry reserves enough journal space for preservation proof and all bounded recovery attempts before stashing',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        writeFile(
          join(context.location, `new-${String(index).padStart(4, '0')}.txt`),
          `private bytes ${index}\n`,
        ),
      ),
    );
    const native = checkoutEditors(context.location);
    const snapshot = await native.capture();
    snapshot.groups[0]!.tabs = [
      {
        kind: 'text',
        uri: 'crw-overview:/legacy.md',
        content: 'x'.repeat(14000),
        active: true,
        preview: false,
        pinned: false,
        views: [],
      },
    ];
    const manager = context.manager(undefined, undefined, undefined, {
      ...native,
      capture: async () => snapshot,
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const result = await manager.enterPullRequestCheckout(source.source.id);
    expect(result, JSON.stringify({ status: result.status, detail: result.detail })).toMatchObject({
      status: 'blocked',
    });
    expect(result.detail).toContain('recovery headroom');
    expect(context.git('stash', 'list')).toBe('');
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(context.git('ls-files', '--others', '--exclude-standard').split('\n')).toHaveLength(400);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'an oversized manifest refuses entry before preservation and leaves all new files in place',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        writeFile(
          join(context.location, `new-${String(index).padStart(4, '0')}.txt`),
          `private bytes ${index}\n`,
        ),
      ),
    );
    const manager = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const result = await manager.enterPullRequestCheckout(source.source.id);
    expect(result, JSON.stringify({ status: result.status, detail: result.detail })).toMatchObject({
      status: 'blocked',
    });
    expect(result.detail).toMatch(/snapshot.*bounded save size/);
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('ls-files', '--others', '--exclude-standard').split('\n')).toHaveLength(600);
    expect(await readFile(join(context.location, 'new-0599.txt'), 'utf8')).toBe(
      'private bytes 599\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'ignored environment and dependency files stay in place through preservation and Exit',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.git', 'info', 'exclude'), '.env\nnode_modules/\n');
    await writeFile(join(context.location, '.env'), 'fixture environment bytes\n');
    await mkdir(join(context.location, 'node_modules'));
    await writeFile(
      join(context.location, 'node_modules', 'fixture.txt'),
      'existing dependencies\n',
    );
    await writeFile(join(context.location, 'worker.ts'), 'raw CRLF bytes\r\nsecond line\r\n');
    const manager = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    expect(await readFile(join(context.location, '.env'), 'utf8')).toBe(
      'fixture environment bytes\n',
    );
    expect(await readFile(join(context.location, 'node_modules', 'fixture.txt'), 'utf8')).toBe(
      'existing dependencies\n',
    );
    expect(await manager.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'raw CRLF bytes\r\nsecond line\r\n',
    );
    expect(await readFile(join(context.location, '.env'), 'utf8')).toBe(
      'fixture environment bytes\n',
    );
    expect(await readFile(join(context.location, 'node_modules', 'fixture.txt'), 'utf8')).toBe(
      'existing dependencies\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['missing', 'moved'])(
  'an original branch that is %s stops restoration and retains protection until the owner repairs it',
  async (state) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'original work\n');
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
    expect(entered).toMatchObject({ status: 'active' });
    if (state === 'missing') context.git('update-ref', '-d', 'refs/heads/prior-work', context.base);
    else context.git('update-ref', 'refs/heads/prior-work', context.head, context.base);
    const failed = await manager.exitPullRequestCheckout();
    expect(failed, JSON.stringify({ status: failed.status, detail: failed.detail })).toMatchObject({
      status: 'recovery',
    });
    expect(failed.detail).toContain('branch');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect(
      context.git(
        'rev-parse',
        `refs/code-review-workbench/recovery/${entered.review!.priorWork!.stashId}/prior-work`,
      ),
    ).toBe(entered.review!.priorWork!.object);
    context.git('update-ref', 'refs/heads/prior-work', context.base);
    const restored = await manager.recoverPullRequestCheckout('restore');
    expect(
      restored,
      JSON.stringify({ status: restored.status, detail: restored.detail }),
    ).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('original work\n');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['save', 'Git stash'])(
  'a concurrent %s after inventory stops preservation before another stash or checkout',
  async (writer) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'inventoried bytes\n');
    let changed = false;
    const manager = context.manager(
      undefined,
      (store) => ({
        request: async (request) => {
          if (request.action === 'preservePriorWork' && !changed) {
            changed = true;
            if (writer === 'save')
              await writeFile(join(context.location, 'worker.ts'), 'concurrent saved bytes\n');
            else context.git('stash', 'push', '-m', 'external writer owns this stash');
          }
          return store.request(request);
        },
        dispose: () => store.dispose(),
      }),
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const result = await manager.enterPullRequestCheckout(source.source.id);
    expect(result, JSON.stringify({ status: result.status, detail: result.detail })).toMatchObject({
      status: 'recovery',
    });
    expect(result.detail).toContain('No new stash was authorized');
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(
      context.git('for-each-ref', '--format=%(refname)', 'refs/code-review-workbench/recovery/'),
    ).toBe('');
    if (writer === 'save') {
      expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
        'concurrent saved bytes\n',
      );
      expect(context.git('stash', 'list')).toBe('');
    } else {
      expect(context.git('stash', 'list', '--format=%gs')).toContain(
        'external writer owns this stash',
      );
      expect(context.git('show', 'refs/stash:worker.ts')).toBe('inventoried bytes');
    }
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'partial Git apply retains foreign work and protection until exact manual reconciliation, without applying twice',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'original index\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'original disk\n');
    await writeFile(join(context.location, 'notes.txt'), 'original new file\n');
    let object = '';
    let interfere = true;
    const manager = context.manager(
      undefined,
      (store) => ({
        request: async (request) => {
          if (request.action === 'restorePriorWork' && interfere) {
            interfere = false;
            await writeFile(join(context.location, 'notes.txt'), 'foreign collision\n');
            expect(() => context.git('stash', 'apply', '--index', object)).toThrow();
          }
          return store.request(request);
        },
        dispose: () => store.dispose(),
      }),
      undefined,
      checkoutEditors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered).toMatchObject({ status: 'active' });
    object = entered.review!.priorWork!.object!;
    const pin = `refs/code-review-workbench/recovery/${entered.review!.priorWork!.stashId}/prior-work`;
    expect(await manager.exitPullRequestCheckout()).toMatchObject({ status: 'recovery' });
    const partialIndex = context.git('ls-files', '--stage', '-z');
    const partialDisk = await readFile(join(context.location, 'worker.ts'), 'utf8');
    expect(await manager.recoverPullRequestCheckout('restore')).toMatchObject({
      status: 'recovery',
    });
    expect(context.git('ls-files', '--stage', '-z')).toBe(partialIndex);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(partialDisk);
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('foreign collision\n');
    expect(context.git('rev-parse', pin)).toBe(object);
    await rename(join(context.location, 'notes.txt'), join(context.directory, 'foreign-notes.txt'));
    await writeFile(join(context.location, 'worker.ts'), 'original index\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'original disk\n');
    await writeFile(join(context.location, 'notes.txt'), 'original new file\n');
    const restored = await manager.recoverPullRequestCheckout('restore');
    expect(
      restored,
      JSON.stringify({ status: restored.status, detail: restored.detail }),
    ).toMatchObject({ status: 'complete' });
    expect(await readFile(join(context.directory, 'foreign-notes.txt'), 'utf8')).toBe(
      'foreign collision\n',
    );
    expect(context.git('stash', 'list', '--format=%H')).toBe(object);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each(['missing', 'moved', 'corrupt stash object'])(
  '%s prior-work protection blocks Exit without changing files and allows Retry after exact repair',
  async (state) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'staged prior work\n');
    context.git('add', 'worker.ts');
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
    expect(entered).toMatchObject({ status: 'active' });
    const prior = entered.review!.priorWork!;
    const ref = `refs/code-review-workbench/recovery/${prior.stashId}/prior-work`;
    const objectPath = join(
      context.location,
      '.git',
      'objects',
      prior.object!.slice(0, 2),
      prior.object!.slice(2),
    );
    let originalObject: Buffer | undefined;
    let originalMode = 0;
    if (state === 'missing') context.git('update-ref', '-d', ref, prior.object!);
    else if (state === 'moved') context.git('update-ref', ref, context.head, prior.object!);
    else {
      originalObject = await readFile(objectPath);
      originalMode = (await stat(objectPath)).mode & 0o777;
      await chmod(objectPath, 0o600);
      await writeFile(objectPath, 'tampered stash object');
    }
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, JSON.stringify({ status: exited.status, detail: exited.detail })).toMatchObject({
      status: 'recovery',
    });
    expect(exited.detail).toMatch(
      state === 'corrupt stash object' ? /Git could not inspect/ : /protection.*missing or moved/,
    );
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect(context.git('status', '--porcelain=v1')).toBe('');
    if (originalObject) {
      await writeFile(objectPath, originalObject);
      await chmod(objectPath, originalMode);
    }
    expect(context.git('show', `${prior.object}^2:worker.ts`)).toBe('staged prior work');
    context.git('update-ref', ref, prior.object!);
    expect(await manager.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(context.git('show', ':worker.ts')).toBe('staged prior work');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'the owned pin preserves an externally removed ordinary stash and Exit reports the real stash-list state',
  async () => {
    const context = await fixture();
    context.git('checkout', '--detach', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'detached prior work\n');
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
    expect(entered).toMatchObject({ status: 'active' });
    context.git('stash', 'drop', 'stash@{0}');
    context.git('prune', '--expire', 'now');
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, JSON.stringify({ status: exited.status, detail: exited.detail })).toMatchObject({
      status: 'complete',
    });
    expect(exited.detail).not.toContain('remains in the ordinary Git stash list');
    expect(exited.detail).toContain('ordinary stash entry is no longer present');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'detached prior work\n',
    );
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  'line-ending conversion',
  'sparse flag',
  'unfinished merge',
  'nested repository',
  ...(process.platform === 'win32' ? [] : ['symbolic link']),
])(
  '%s takes the pre-mutation fallback while exact committed reading remains available',
  async (representation) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'unfinished original bytes\n');
    if (representation === 'line-ending conversion') context.git('config', 'core.autocrlf', 'true');
    else if (representation === 'sparse flag')
      context.git('update-index', '--skip-worktree', 'worker.ts');
    else if (representation === 'unfinished merge')
      await writeFile(join(context.location, '.git', 'MERGE_HEAD'), `${context.head}\n`);
    else if (representation === 'symbolic link')
      await symlink('worker.ts', join(context.location, 'link.txt'));
    else {
      await mkdir(join(context.location, 'nested'));
      context.git('init', join(context.location, 'nested'));
      await writeFile(join(context.location, 'nested', 'private.txt'), 'nested work');
    }
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
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'blocked',
    });
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unfinished original bytes\n',
    );
    const file = source.source.files.find((file) => file.path === 'worker.ts')!;
    expect(await manager.readCommittedFile(source.source.id, file.id, 'new')).toMatchObject({
      status: 'available',
      text: 'export const count = 2;\n// committed\n',
    });
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

import { expect, test } from 'vitest';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fixture, integrationTimeout } from './fixtures/committed-review';
import type { CheckoutEditors } from '../src/application/checkout-review';

function editors(workspace: string): CheckoutEditors {
  return {
    capture: async () => ({
      protocol: 1,
      workspace,
      layout: { groups: [{ size: 1 }] },
      groups: [{ column: 1, active: true, tabs: [] }],
    }),
    assertSaved() {},
    restore: async () => {},
  };
}

test(
  'Enter and Exit restore staged and unstaged bytes, renames and new files alongside unrelated stashes',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'unrelated stash\n');
    context.git('stash', 'push', '-m', 'user backup');
    const unrelated = context.git('rev-parse', 'refs/stash');
    await writeFile(join(context.location, 'worker.ts'), 'staged bytes\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'unstaged bytes 🐈\n');
    context.git('mv', 'delete.py', 'renamed.py');
    await writeFile(join(context.location, 'notes.txt'), 'new private work\n');
    const status = context.git('status', '--porcelain=v1', '-z');
    const index = context.git('ls-files', '--stage', '-z');
    const manager = context.manager(undefined, undefined, undefined, editors(context.location));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, JSON.stringify(entered)).toMatchObject({ status: 'active' });
    expect(context.git('status', '--porcelain=v1')).toBe('');
    expect(context.git('show', 'HEAD:worker.ts')).toBe('export const count = 2;\n// committed');
    expect(await manager.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('status', '--porcelain=v1', '-z')).toBe(status);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('unstaged bytes 🐈\n');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new private work\n');
    expect(context.git('stash', 'list', '--format=%H')).toContain(unrelated);
    expect(context.git('show', `${unrelated}:worker.ts`)).toBe('unrelated stash');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Exit restores unstaged deletion, executable staging and exact binary new-file bytes',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await rm(join(context.location, 'delete.py'));
    const bytes = Buffer.from([0, 255, 13, 10, 0, 128]);
    await writeFile(join(context.location, 'new.bin'), bytes);
    if (process.platform !== 'win32') {
      await chmod(join(context.location, 'worker.ts'), 0o755);
      context.git('add', 'worker.ts');
    }
    const status = context.git('status', '--porcelain=v1', '-z');
    const index = context.git('ls-files', '--stage', '-z');
    const manager = context.manager(undefined, undefined, undefined, editors(context.location));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, JSON.stringify(exited)).toMatchObject({ status: 'complete' });
    expect(context.git('status', '--porcelain=v1', '-z')).toBe(status);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'new.bin'))).toEqual(bytes);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  'intent-to-add',
  'filter',
  ...(process.platform === 'win32' ? [] : ['newline path']),
  'case-only rename',
])(
  'unsupported %s preserves prior work before any stash or checkout',
  async (representation) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'do not mutate these bytes\n');
    if (representation === 'intent-to-add') {
      await writeFile(join(context.location, 'notes.txt'), 'intent-to-add\n');
      context.git('add', '-N', 'notes.txt');
    } else if (representation === 'filter') context.git('config', 'filter.demo.clean', 'cat');
    else if (representation === 'newline path')
      await writeFile(join(context.location, 'new\nfile.txt'), 'new bytes');
    else context.git('mv', 'worker.ts', 'Worker.ts');
    const status = context.git('status', '--porcelain=v1', '-z');
    const index = context.git('ls-files', '--stage', '-z');
    const manager = context.manager(undefined, undefined, undefined, editors(context.location));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const result = await manager.enterPullRequestCheckout(source.source.id);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked' });
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(context.git('stash', 'list')).toBe('');
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('status', '--porcelain=v1', '-z')).toBe(status);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a known preparation refusal after stashing restores prior work and keeps the original error',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'keep this unfinished work\n');
    const manager = context.manager(
      undefined,
      (store) => ({
        request: async (request) => {
          if (request.action === 'prepareCleanCheckout')
            context.git('branch', `code-review-workbench/${request.id}`, context.head);
          return store.request(request);
        },
        dispose: () => store.dispose(),
      }),
      undefined,
      editors(context.location),
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, JSON.stringify(entered)).toMatchObject({ status: 'blocked' });
    expect(entered.detail).toContain('branch');
    expect((await manager.readCheckoutReview())?.phase).toBe('complete');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'keep this unfinished work\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'a refused PR checkout automatically restores prior work while retaining ignored collisions',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, '.git', 'info', 'exclude'), 'new.py\n');
    await writeFile(join(context.location, 'new.py'), 'ignored local bytes\n');
    await writeFile(join(context.location, 'worker.ts'), 'unfinished prior work\n');
    const manager = context.manager(undefined, undefined, undefined, editors(context.location));
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entered = await manager.enterPullRequestCheckout(source.source.id);
    expect(entered, JSON.stringify(entered)).toMatchObject({ status: 'blocked' });
    expect((await manager.readCheckoutReview())?.phase).toBe('complete');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'unfinished prior work\n',
    );
    expect(await readFile(join(context.location, 'new.py'), 'utf8')).toBe('ignored local bytes\n');
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test.each([
  { boundary: 'stash-push.dispatch.before', stage: undefined, status: 'active' },
  { boundary: 'stash-apply.dispatch.before', stage: 'exit' as const, status: 'complete' },
])(
  'Recover can retry a verified unperformed operation at $boundary',
  async ({ boundary, stage, status }) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'staged prior bytes\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'notes.txt'), 'new prior bytes\n');
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child } = await context.interruptedInspector(source.source.id, boundary, stage);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = context.manager(undefined, undefined, undefined, editors(context.location));
    let result = await recovered.recoverPullRequestCheckout(stage ? 'restore' : 'continue');
    const deadline = Date.now() + 5000;
    while (
      /recorded Git process or its descendants may still run/.test(result.detail) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await recovered.recoverPullRequestCheckout(stage ? 'restore' : 'continue');
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status });
    if (status === 'active')
      expect(await recovered.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(context.git('show', ':worker.ts')).toBe('staged prior bytes');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new prior bytes\n');
    expect(context.git('stash', 'list', '--format=%H').split('\n')).toHaveLength(1);
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Recover recognizes prior-work apply success before its receipt and never applies the stash twice',
  async () => {
    const context = await fixture();
    context.git('checkout', '--detach', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'staged before review\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'notes.txt'), 'new before review\n');
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child, result } = await context.interruptedInspector(
      source.source.id,
      'stash-apply.effect.after',
      'exit',
    );
    expect(result.result).toMatchObject({ status: 'recovery' });
    const stash = context.git('rev-parse', 'refs/stash');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = context.manager(undefined, undefined, undefined, editors(context.location));
    const restored = await recovered.recoverPullRequestCheckout('restore');
    expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'complete' });
    expect(context.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(context.git('show', ':worker.ts')).toBe('staged before review');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new before review\n');
    expect(context.git('stash', 'list', '--format=%H')).toBe(stash);
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Recover finds a stash after Git succeeded before its object was recorded, without creating another stash',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'recover staged bytes\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'recover unstaged bytes\n');
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child, result } = await context.interruptedInspector(
      source.source.id,
      'stash-push.effect.after',
    );
    expect(result.result).toMatchObject({ status: 'recovery' });
    const stash = context.git('rev-parse', 'refs/stash');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = context.manager(undefined, undefined, undefined, editors(context.location));
    const resumed = await recovered.recoverPullRequestCheckout('continue');
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'active' });
    expect(context.git('stash', 'list', '--format=%H')).toBe(stash);
    expect(await recovered.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(context.git('show', ':worker.ts')).toBe('recover staged bytes');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'recover unstaged bytes\n',
    );
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

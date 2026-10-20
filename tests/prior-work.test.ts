import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
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

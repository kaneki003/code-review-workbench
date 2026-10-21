import { expect, test } from 'vitest';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, integrationTimeout, checkoutEditors } from './fixtures/committed-review';

test(
  'Exit releases owned recovery pins after completion while reordered ordinary stashes remain intact',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'unrelated earlier work\n');
    context.git('stash', 'push', '-m', 'earlier user stash');
    const earlier = context.git('rev-parse', 'refs/stash');
    await writeFile(join(context.location, 'worker.ts'), 'original staged\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'notes.txt'), 'original new bytes\n');
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
    const preserved = entered.review!.priorWork!.object!;
    await writeFile(join(context.location, 'worker.ts'), 'unrelated later work\n');
    context.git('stash', 'push', '-m', 'later user stash');
    const later = context.git('rev-parse', 'refs/stash');
    const exited = await manager.exitPullRequestCheckout();
    expect(exited, JSON.stringify(exited)).toMatchObject({ status: 'complete' });
    expect(
      context.git('for-each-ref', '--format=%(refname)', 'refs/code-review-workbench/recovery/'),
    ).toBe('');
    expect(context.git('stash', 'list', '--format=%H').split('\n')).toEqual([
      later,
      preserved,
      earlier,
    ]);
    expect(context.git('show', `${earlier}:worker.ts`)).toBe('unrelated earlier work');
    expect(context.git('show', `${later}:worker.ts`)).toBe('unrelated later work');
    expect(context.git('show', ':worker.ts')).toBe('original staged');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe(
      'original new bytes\n',
    );
    await manager.releasePrivateStore();
  },
  integrationTimeout,
);

test(
  'Continue recovers an unperformed PR checkout after preserving prior work, then Exit restores it',
  async () => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'staged original bytes\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'disk original bytes\n');
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child } = await context.interruptedInspector(
      source.source.id,
      'checkout.dispatch.before',
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    let result = await recovered.recoverPullRequestCheckout('continue');
    const deadline = Date.now() + 5000;
    while (
      /recorded Git process or its descendants may still run/.test(result.detail) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await recovered.recoverPullRequestCheckout('continue');
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'active' });
    expect(await recovered.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(context.git('show', ':worker.ts')).toBe('staged original bytes');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'disk original bytes\n',
    );
    expect(context.git('stash', 'list', '--format=%H').split('\n')).toHaveLength(1);
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

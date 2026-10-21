import { expect, test } from 'vitest';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, integrationTimeout, checkoutEditors } from './fixtures/committed-review';
import type { StorageDiagnostics } from '../src/connections/storage-diagnostics';

test.each([
  { boundary: 'checkout-entering.commit.before', stage: undefined, mode: 'commit' as const },
  { boundary: 'checkout-entering.record', stage: undefined, mode: 'native' as const },
  ...[
    'checkout-entering.record.after',
    'stash-push.prepared.before',
    'stash-push.prepared.record.after',
    'stash-push.dispatch.before',
    'stash-push.dispatch.after',
    'stash-push.effect.after',
    'stash-push.observed.record.after',
    'prior-work-pin.prepared.record.after',
    'prior-work-pin.dispatch.before',
    'prior-work-pin.effect.after',
    'prior-work-preserved.before',
    'prior-work-preserved.record.after',
    'prior-work-preserved.commit.after',
    'original-pin.effect.after',
    'checkout.prepared.record.after',
    'checkout.dispatch.before',
    'checkout.effect.after',
    'checkout-active.commit.after',
  ].map((boundary) => ({ boundary, stage: undefined })),
  ...[
    'checkout-exiting.record.after',
    'restore-checkout.dispatch.before',
    'restore-checkout.effect.after',
    'stash-apply.prepared.record.after',
    'stash-apply.dispatch.before',
    'stash-apply.dispatch.after',
    'stash-apply.effect.after',
    'stash-apply.observed.record.after',
    'prior-work-verified.before',
    'prior-work-verified.after',
    'checkout-restoring-editors.record.after',
    'checkout-complete.record.before',
    'checkout-complete.commit.after',
    'original-cleanup.dispatch.before',
    'original-cleanup.effect.after',
    'prior-work-cleanup.dispatch.before',
    'prior-work-cleanup.effect.after',
    'prior-work-cleanup.observed.record.after',
  ].map((boundary) => ({ boundary, stage: 'exit' as const })),
])(
  'Restore verifies original work after a worker crash at $boundary',
  async ({
    boundary,
    stage,
    mode = 'crash',
  }: {
    boundary: string;
    stage: 'exit' | undefined;
    mode?: StorageDiagnostics['mode'];
  }) => {
    const context = await fixture();
    context.git('checkout', '-b', 'prior-work', context.base);
    await writeFile(join(context.location, 'worker.ts'), 'unrelated retained stash\n');
    context.git('stash', 'push', '-m', 'unrelated');
    const unrelated = context.git('rev-parse', 'refs/stash');
    await writeFile(join(context.location, 'worker.ts'), 'staged before crash\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'disk before crash\n');
    await writeFile(join(context.location, 'notes.txt'), 'new before crash\n');
    const index = context.git('ls-files', '--stage', '-z');
    const first = context.manager();
    await first.openPullRequestOverview(context.pullRequest.url);
    const source = await first.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await first.dispose();
    const { child, result } = await context.interruptedInspector(
      source.source.id,
      boundary,
      stage,
      mode,
    );
    expect(['recovery', 'blocked'], JSON.stringify({ status: result.status, detail: result.detail })).toContain(result.result.status);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = context.manager(
      undefined,
      undefined,
      undefined,
      checkoutEditors(context.location),
    );
    let restored = await recovered.recoverPullRequestCheckout('restore');
    const deadline = Date.now() + 5000;
    while (
      /recorded Git process or its descendants may still run/.test(restored.detail) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      restored = await recovered.recoverPullRequestCheckout('restore');
    }
    expect(restored, JSON.stringify({ status: restored.status, detail: restored.detail })).toMatchObject({ status: 'complete' });
    expect(context.git('symbolic-ref', 'HEAD')).toBe('refs/heads/prior-work');
    expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
    expect(context.git('ls-files', '--stage', '-z')).toBe(index);
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('disk before crash\n');
    expect(await readFile(join(context.location, 'notes.txt'), 'utf8')).toBe('new before crash\n');
    const stashes = context.git('stash', 'list', '--format=%H').split('\n');
    expect(stashes).toContain(unrelated);
    expect(stashes.length).toBeLessThanOrEqual(2);
    expect(
      context.git('for-each-ref', '--format=%(refname)', 'refs/code-review-workbench/recovery/'),
    ).toBe('');
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

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
    expect(exited, JSON.stringify({ status: exited.status, detail: exited.detail })).toMatchObject({ status: 'complete' });
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
    expect(result, JSON.stringify({ status: result.status, detail: result.detail })).toMatchObject({ status: 'active' });
    expect(await recovered.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(context.git('show', ':worker.ts')).toBe('staged original bytes');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'disk original bytes\n',
    );
    expect(context.git('stash', 'list', '--format=%H').split('\n')).toHaveLength(1);
    expect(
      context.git('for-each-ref', '--format=%(refname)', 'refs/code-review-workbench/recovery/'),
    ).toBe('');
    await recovered.releasePrivateStore();
  },
  integrationTimeout,
);

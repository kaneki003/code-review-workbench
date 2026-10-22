import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckoutGit } from '../../src/git/checkout';

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'crw-checkout-'));
  cleanups.push(directory);
  const location = join(directory, 'repository');
  await mkdir(location);
  const git = (...arguments_: string[]) =>
    execFileSync('git', ['-C', location, ...arguments_], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Checkout Fixture');
  git('config', 'user.email', 'checkout@example.test');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(location, 'tracked.txt'), 'base\n');
  await writeFile(join(location, 'target.txt'), 'base target\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'feature');
  await writeFile(join(location, 'target.txt'), 'review target\n');
  git('add', 'target.txt');
  git('commit', '-m', 'target');
  const target = git('rev-parse', 'HEAD');
  git('switch', 'main');
  return { directory, location, git, base, target };
}

test('ordinary stash and switch restore staged, unstaged and untracked work', async () => {
  const context = await repository();
  await writeFile(join(context.location, 'tracked.txt'), 'staged\n');
  context.git('add', 'tracked.txt');
  await writeFile(join(context.location, 'tracked.txt'), 'staged\nunstaged\n');
  await writeFile(join(context.location, 'untracked.txt'), 'new\n');

  const checkout = createCheckoutGit({ repository: context.location, windowId: 'window-a' });
  const entered = await checkout.enter('source-1', context.target);
  expect(entered, entered.detail).toMatchObject({
    status: 'active',
    review: { step: 'active', original: { branch: 'main', commit: context.base } },
  });
  expect(context.git('rev-parse', 'HEAD')).toBe(context.target);
  expect(context.git('status', '--porcelain=v1')).toBe('');

  const exited = await checkout.exit();
  expect(exited, exited.detail).toMatchObject({ status: 'complete' });
  expect(context.git('symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
  expect(context.git('diff', '--cached', '--', 'tracked.txt')).toContain('+staged');
  expect(context.git('diff', '--', 'tracked.txt')).toContain('+unstaged');
  expect(await readFile(join(context.location, 'untracked.txt'), 'utf8')).toBe('new\n');
  expect(context.git('stash', 'list')).toBe('');
  expect(await checkout.read()).toBeUndefined();
});

test('different repositories proceed while another window is refused for the same checkout', async () => {
  const first = await repository();
  const second = await repository();
  const firstWindow = createCheckoutGit({ repository: first.location, windowId: 'window-a' });
  const competingWindow = createCheckoutGit({ repository: first.location, windowId: 'window-b' });
  const independentWindow = createCheckoutGit({
    repository: second.location,
    windowId: 'window-c',
  });

  expect(await firstWindow.enter('source-1', first.target)).toMatchObject({ status: 'active' });
  expect(await competingWindow.enter('source-2', first.target)).toMatchObject({
    status: 'blocked',
    detail: expect.stringMatching(/window-a/),
  });
  expect(await independentWindow.enter('source-3', second.target)).toMatchObject({
    status: 'active',
  });

  expect(await firstWindow.exit()).toMatchObject({ status: 'complete' });
  expect(await independentWindow.exit()).toMatchObject({ status: 'complete' });
});

test('failed Git commands retain exact diagnostics and require manual acknowledgement', async () => {
  const context = await repository();
  const checkout = createCheckoutGit({ repository: context.location, windowId: 'window-a' });
  const missing = '0'.repeat(40);

  const result = await checkout.enter('missing-source', missing);
  expect(result).toMatchObject({ status: 'recovery', review: { step: 'manual-recovery' } });
  expect(result.detail).toContain(`git -C ${context.location} switch --detach ${missing}`);
  expect(result.detail).toMatch(/stderr:/);
  expect(await checkout.read()).toMatchObject({
    step: 'manual-recovery',
    failure: { command: expect.stringContaining('switch --detach') },
  });

  expect(await checkout.clearRecovery()).toMatchObject({ status: 'complete' });
  expect(await checkout.read()).toBeUndefined();
  expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
});

test('a stash conflict stops Exit and leaves the stash and receipt for the user', async () => {
  const context = await repository();
  await writeFile(join(context.location, 'tracked.txt'), 'prior work\n');
  const checkout = createCheckoutGit({ repository: context.location, windowId: 'window-a' });
  const entered = await checkout.enter('source-1', context.target);
  expect(entered).toMatchObject({ status: 'active' });
  await writeFile(join(context.location, 'tracked.txt'), 'review work\n');

  const exited = await checkout.exit();
  expect(exited).toMatchObject({ status: 'recovery', review: { step: 'manual-recovery' } });
  expect(exited.detail).toContain('stash apply --index');
  expect(context.git('stash', 'list')).toContain('code-review-workbench:');
  expect(await checkout.read()).toMatchObject({ step: 'manual-recovery' });
});

test('a detached original checkout is restored without creating a branch', async () => {
  const context = await repository();
  context.git('switch', '--detach', context.base);
  const checkout = createCheckoutGit({ repository: context.location, windowId: 'window-a' });

  expect(await checkout.enter('source-1', context.target)).toMatchObject({ status: 'active' });
  expect(await checkout.exit()).toMatchObject({ status: 'complete' });
  expect(context.git('rev-parse', '--symbolic-full-name', 'HEAD')).toBe('HEAD');
  expect(context.git('rev-parse', 'HEAD')).toBe(context.base);
});

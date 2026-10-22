import { expect, test } from 'vitest';

import { writeFile, readFile } from 'node:fs/promises';

import { join } from 'node:path';

import { fixture, integrationTimeout } from '../support/review/committed-review';

test(
  'cancelled host saving prevents checkout and creates no receipt or stash',
  async () => {
    const context = await fixture();
    const manager = context.manager(undefined, undefined, undefined, { save: async () => false });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await writeFile(join(context.location, 'worker.ts'), 'unfinished work\n');
    const before = context.git('rev-parse', 'HEAD');
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'blocked',
      detail: expect.stringMatching(/Save was cancelled or failed/),
    });
    expect(await manager.readCheckoutReview()).toBeUndefined();
    expect(context.git('rev-parse', 'HEAD')).toBe(before);
    expect(context.git('stash', 'list')).toBe('');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe('unfinished work\n');
  },
  integrationTimeout,
);

test(
  'manager routes retained source to ordinary checkout and Exit restores repository work',
  async () => {
    const context = await fixture();
    context.git('switch', '-c', 'prior-work', context.base);
    let saves = 0;
    const manager = context.manager(undefined, undefined, undefined, {
      save: async () => {
        saves += 1;
        return true;
      },
    });
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    await writeFile(join(context.location, 'worker.ts'), 'staged work\n');
    context.git('add', 'worker.ts');
    await writeFile(join(context.location, 'worker.ts'), 'staged work\nunstaged work\n');
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
      review: { sourceId: source.source.id, step: 'active', target: context.head },
    });
    expect(context.git('rev-parse', 'HEAD')).toBe(context.head);
    expect(await manager.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(saves).toBe(2);
    expect(context.git('symbolic-ref', '--short', 'HEAD')).toBe('prior-work');
    expect(context.git('show', ':worker.ts')).toBe('staged work');
    expect(await readFile(join(context.location, 'worker.ts'), 'utf8')).toBe(
      'staged work\nunstaged work\n',
    );
    expect(await manager.readCheckoutReview()).toBeUndefined();
  },
  integrationTimeout,
);

test(
  'an active checkout keeps its PR selected until Exit completes',
  async () => {
    const context = await fixture();
    const manager = context.manager();
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    expect(await manager.enterPullRequestCheckout(source.source.id)).toMatchObject({
      status: 'active',
    });
    expect(await manager.openPullRequestOverview(context.pullRequest.url)).toMatchObject({
      status: 'ready',
    });
    context.pullRequest.number = 21;
    context.pullRequest.url = 'https://github.com/acme/service/pull/21';
    expect(await manager.openPullRequestOverview(context.pullRequest.url)).toMatchObject({
      status: 'blocked',
      detail: expect.stringMatching(/current checkout before selecting another PR/),
    });
    expect(await manager.readCheckoutReview()).toMatchObject({
      sourceId: source.source.id,
      step: 'active',
    });
    expect(await manager.exitPullRequestCheckout()).toMatchObject({ status: 'complete' });
    expect(await manager.openPullRequestOverview(context.pullRequest.url)).toMatchObject({
      status: 'ready',
    });
  },
  integrationTimeout,
);

test(
  'PR selection waits for a checkout whose document save is still pending',
  async () => {
    const context = await fixture();
    let releaseSave!: () => void;
    let saving!: () => void;
    let registrationRead!: () => void;
    let observeSelection = false;
    const saveStarted = new Promise<void>((resolve) => {
      saving = resolve;
    });
    const selectionStarted = new Promise<void>((resolve) => {
      registrationRead = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const manager = context.manager(
      undefined,
      (store) => ({
        ...store,
        async request(request) {
          const reply = await store.request(request);
          if (observeSelection && request.action === 'readRegistration') registrationRead();
          return reply;
        },
      }),
      undefined,
      {
        save: async () => {
          saving();
          await saveGate;
          return true;
        },
      },
    );
    await manager.openPullRequestOverview(context.pullRequest.url);
    const source = await manager.inspectPullRequestSource('3001', 20);
    if (source.status !== 'ready') throw new Error(source.detail);
    const entering = manager.enterPullRequestCheckout(source.source.id);
    await saveStarted;
    context.pullRequest.number = 21;
    context.pullRequest.url = 'https://github.com/acme/service/pull/21';
    observeSelection = true;
    const selecting = manager.openPullRequestOverview(context.pullRequest.url);
    try {
      await selectionStarted;
    } finally {
      releaseSave();
    }
    expect(await entering).toMatchObject({ status: 'active' });
    expect(await selecting).toMatchObject({ status: 'blocked' });
    expect(await manager.readCheckoutReview()).toMatchObject({ sourceId: source.source.id });
  },
  integrationTimeout,
);

import { afterEach, expect, test } from 'vitest';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ReviewManager } from '../src/application/review-manager';
import { createStoreConnection } from '../src/connections/shared-store';
import type {
  StoreConfiguration,
  StoreConnection,
  StoreRequest,
} from '../src/application/private-store';
import type { StoreView } from '../src/application/private-store';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'crw-store-')));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const worker = join(directory, 'store-worker.cjs');
  await build({
    entryPoints: ['src/connections/store-worker.ts'],
    outfile: worker,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
  });
  await cp(resolve('native/build/Release/crw_guard.node'), join(directory, 'native-guard.node'));
  const processPath = join(directory, 'store-process.cjs');
  await build({
    entryPoints: ['tests/fixtures/store-process.ts'],
    outfile: processPath,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
  });
  async function contender(name: string, data = 'data-A') {
    const child = fork(
      processPath,
      [
        worker,
        JSON.stringify({
          osHome: home,
          candidateRoot: join(home, data),
          windowId: name,
          location: join(directory, name),
        }),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, HOME: join(directory, name), USERPROFILE: join(directory, name) },
      },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    });
    await once(child, 'message');
    let sequence = 0;
    return {
      child,
      async send(
        action:
          'open' | 'release' | 'renew' | 'inspect' | 'reserve-child' | 'prepare-ref' | 'recover',
        args?: string[],
      ): Promise<StoreView> {
        const response = once(child, 'message');
        child.send({ id: ++sequence, action, args, ref: args?.[0], oid: args?.[1] });
        return (await response)[0].view as StoreView;
      },
    };
  }
  const connections = new Map<string, StoreConnection>();
  function manager(
    name: string,
    data = 'data-A',
    actor?: StoreConfiguration['actor'],
    wrap: (connection: StoreConnection) => StoreConnection = (connection) => connection,
  ) {
    const store = wrap(
      createStoreConnection(worker, {
        osHome: home,
        candidateRoot: join(home, data),
        windowId: name,
        location: join(directory, name),
        ...(actor ? { actor } : {}),
      }),
    );
    connections.set(name, store);
    cleanups.push(() => store.dispose());
    return new ReviewManager({
      environment: () => ({
        vscode: '1.142.0',
        node: process.versions.node,
        electron: undefined,
        chrome: undefined,
        platform: process.platform,
        arch: process.arch,
        desktop: true,
        trusted: true,
        remote: undefined,
        folders: [{ scheme: 'file', path: join(directory, name) }],
      }),
      git: async () => ({ id: 'git', label: 'Git', status: 'passed', detail: 'Separate probe' }),
      sqlite: async () => ({
        id: 'sqlite',
        label: 'SQLite',
        status: 'passed',
        detail: 'Separate probe',
      }),
      native: async () => ({
        id: 'guard',
        label: 'Helper',
        status: 'passed',
        detail: 'Separate probe',
      }),
      store,
    });
  }
  return { directory, home, worker, manager, connections, contender };
}

test('one manager opens the durable store; a second sees only its location and later claims the same store', async () => {
  const context = await fixture();
  const first = context.manager('first');
  const second = context.manager('second', 'data-B');
  const owned = await first.openPrivateStore();
  expect(owned.status, JSON.stringify(owned)).toBe('owned');
  expect(owned).toMatchObject({ status: 'owned', root: join(context.home, 'data-A'), fence: 1 });
  expect(owned.process).toMatchObject({ pid: process.pid, start: expect.any(String) });
  const busy = await second.openPrivateStore();
  expect(busy).toMatchObject({ status: 'busy', ownerLocation: join(context.directory, 'first') });
  expect(busy).not.toHaveProperty('scopeId');
  expect(busy).not.toHaveProperty('token');
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const next = await second.openPrivateStore();
  expect(next).toMatchObject({
    status: 'owned',
    root: owned.root,
    storeId: owned.storeId,
    incarnation: owned.incarnation,
    scopeId: owned.scopeId,
    fence: 2,
  });
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('host configuration uses OS account home despite process home overrides and rejects relative data roots', async () => {
  const context = await fixture();
  const resolver = join(context.directory, 'location.cjs');
  await build({
    entryPoints: ['src/connections/store-location.ts'],
    outfile: resolver,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const run = (extra: NodeJS.ProcessEnv = {}) =>
    execFileSync(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify(require(process.argv[1]).resolveStoreConfiguration(process.argv[2])))',
        resolver,
        context.directory,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, HOME: context.home, USERPROFILE: context.home, ...extra },
      },
    );
  expect(JSON.parse(run()).osHome).toBe(userInfo().homedir);
  if (process.platform === 'linux') expect(() => run({ XDG_DATA_HOME: 'relative/data' })).toThrow();
  if (process.platform === 'win32') expect(() => run({ LOCALAPPDATA: 'relative/data' })).toThrow();
});

test('a typed reference update checks repository facts, records its outcome and permits release', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  const oid = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const manager = context.manager('repository');
  expect(await manager.openPrivateStore()).toMatchObject({ status: 'owned' });
  const plan = await manager.prepareReferenceUpdate('refs/code-review-workbench/test', oid);
  expect(plan.operation, JSON.stringify(plan)).toMatchObject({ phase: 'prepared' });
  expect(() =>
    execFileSync(
      'git',
      ['-C', repository, 'rev-parse', '--verify', 'refs/code-review-workbench/test'],
      { stdio: 'pipe' },
    ),
  ).toThrow();
  const result = await manager.executeRepositoryOperation(plan.operation!.id);
  expect(result.operation, JSON.stringify(result)).toMatchObject({
    phase: 'observed',
    outcome: 'applied',
  });
  expect(
    execFileSync('git', ['-C', repository, 'rev-parse', 'refs/code-review-workbench/test'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe(oid);
  expect(await manager.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('recovery cancels an undispatched operation after its host dies without replaying it', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  const oid = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const owner = await context.contender('repository');
  expect(await owner.send('open')).toMatchObject({ status: 'owned' });
  expect(
    await owner.send('prepare-ref', ['refs/code-review-workbench/recovery', oid]),
  ).toMatchObject({ status: 'recovery' });
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const next = context.manager('repository', 'data-B');
  expect(await next.openPrivateStore()).toMatchObject({ status: 'recovery' });
  const reconciled = await next.recoverPrivateStore();
  expect(reconciled.view, JSON.stringify(reconciled)).toMatchObject({ status: 'closed' });
  expect(reconciled.operation).toMatchObject({ phase: 'observed', outcome: 'not-applied' });
  expect(() =>
    execFileSync(
      'git',
      ['-C', repository, 'rev-parse', '--verify', 'refs/code-review-workbench/recovery'],
      { stdio: 'pipe' },
    ),
  ).toThrow();
  expect(await next.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
  expect(await next.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('real processes with different home and data variables never register a second store', async () => {
  const context = await fixture();
  const first = await context.contender('first');
  const second = await context.contender('second', 'data-B');
  const results = await Promise.all([first.send('open'), second.send('open')]);
  expect(results.filter((view) => view.status === 'owned').length).toBeLessThanOrEqual(1);
  expect(results.every((view) => ['owned', 'busy', 'recovery'].includes(view.status))).toBe(true);
  const registered = JSON.parse(
    await readFile(join(context.home, '.code-review-workbench', 'store-location.json'), 'utf8'),
  );
  const winner = results.findIndex((view) => view.status === 'owned');
  expect(winner).toBeGreaterThanOrEqual(0);
  expect(results[winner]!.root).toBe(registered.root);
  expect(await [first, second][winner]!.send('release')).toMatchObject({ status: 'closed' });
});

test('after host death only one of two reclaimers obtains the next generation', async () => {
  const context = await fixture();
  const owner = await context.contender('owner');
  expect(await owner.send('open')).toMatchObject({ status: 'owned', fence: 1 });
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const first = await context.contender('first', 'data-B');
  const second = await context.contender('second', 'data-C');
  const results = await Promise.all([first.send('open'), second.send('open')]);
  expect(results.map((view) => view.status).sort()).toEqual(['busy', 'owned']);
  expect(results.find((view) => view.status === 'owned')!.fence).toBe(2);
});

test('worker death with a still-live host refuses takeover, even with an ancient heartbeat', async () => {
  const context = await fixture();
  const owner = context.manager('owner');
  expect(await owner.openPrivateStore()).toMatchObject({ status: 'owned' });
  await context.connections.get('owner')!.dispose();
  const path = join(context.home, '.code-review-workbench', 'control.json');
  const control = JSON.parse(await readFile(path, 'utf8'));
  control.owner.heartbeat = 1;
  await writeFile(path, JSON.stringify(control));
  expect(await context.manager('second').openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'RECOVERY_REQUIRED',
  });
});

test('handoff opens only the named window, and a failed handoff stays closed to everyone else', async () => {
  const context = await fixture();
  const first = context.manager('first');
  const opened = await first.openPrivateStore();
  expect(opened.status).toBe('owned');
  const offered = await first.offerStoreHandoff('second');
  expect(offered.view.status).toBe('closed');
  expect(offered.handoff).toBeDefined();
  const intruder = context.manager('third');
  expect(await intruder.openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'HANDOFF_PENDING',
  });
  const second = context.manager('second');
  expect(await second.openPrivateStore(offered.handoff)).toMatchObject({
    status: 'owned',
    fence: 2,
    storeId: opened.storeId,
  });
  expect(await first.renewOwnership()).toMatchObject({ status: 'recovery', code: 'STALE_LEASE' });
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

test('repository intent records sorted linked-worktree scopes and blocks every further mutation', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  const linked = join(context.directory, 'linked');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  execFileSync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  execFileSync('git', ['-C', repository, 'worktree', 'add', '-b', 'linked', linked]);
  const manager = context.manager('linked');
  expect(await manager.openPrivateStore()).toMatchObject({ status: 'owned' });
  const [first, second] = await Promise.all([
    manager.recordRepositoryIntent(),
    manager.recordRepositoryIntent(),
  ]);
  expect(first.reservation?.scopes).toHaveLength(2);
  expect(first.reservation!.scopes).toEqual([...first.reservation!.scopes].sort());
  expect(
    first.reservation!.scopes.some((scope) => scope.endsWith(':' + join(repository, '.git'))),
  ).toBe(true);
  expect(first.reservation!.scopes.some((scope) => scope.endsWith(':' + linked))).toBe(true);
  expect(second.view.status).toBe('recovery');
  expect(second.reservation).toBeUndefined();
  expect(await manager.releasePrivateStore()).toMatchObject({ status: 'recovery' });
  expect((await manager.offerStoreHandoff('second')).view.status).toBe('recovery');
});

test('a changed store identity fences queued repository intent before acknowledging it', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  const manager = context.manager('repository', 'data-A', undefined, (connection) => ({
    ...connection,
    async request(request) {
      if (request.action === 'recordIntent') {
        const path = join(context.home, '.code-review-workbench', 'store-location.json');
        const record = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...record, incarnation: randomUUID() }));
      }
      return connection.request(request);
    },
  }));
  expect(await manager.openPrivateStore()).toMatchObject({ status: 'owned' });
  expect((await manager.recordRepositoryIntent()).view).toMatchObject({ status: 'recovery' });
  expect(() => execFileSync('git', ['-C', repository, 'config', '--local', 'crw.test'])).toThrow();
});

test('GitHub accounts have stable separate scopes and share the same OS-user exclusion', async () => {
  const context = await fixture();
  const first = context.manager('first', 'data-A', { host: 'github.com', userId: '1001' });
  const second = context.manager('second', 'data-B', { host: 'github.com', userId: '1002' });
  const owned = await first.openPrivateStore();
  const busy = await second.openPrivateStore();
  expect(Object.keys(busy).sort()).toEqual(['detail', 'ownerLocation', 'status']);
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const other = await second.openPrivateStore();
  expect(other.scopeId).not.toBe(owned.scopeId);
  expect(other.storeId).toBe(owned.storeId);
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
  expect(await first.openPrivateStore()).toMatchObject({
    status: 'owned',
    scopeId: owned.scopeId,
    fence: 3,
  });
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('an acknowledged intent survives host death and a live fixture child; no takeover after it finishes', async () => {
  const context = await fixture();
  const repository = join(context.directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', repository]);
  await writeFile(
    join(repository, 'child.cjs'),
    `
    const fs = require('node:fs');
    fs.writeFileSync('child-started', String(process.pid));
    setTimeout(() => {
      require('node:child_process').execFileSync('git', ['config', '--local', 'crw.child', 'survived']);
      fs.writeFileSync('child-done', 'done');
    }, 1500);
  `,
  );
  const owner = await context.contender('repository');
  expect(await owner.send('open')).toMatchObject({ status: 'owned' });
  expect(await owner.send('reserve-child')).toMatchObject({
    status: 'recovery',
    code: 'OPERATION_PENDING',
  });
  await waitForFile(join(repository, 'child-started'));
  const exited = once(owner.child, 'exit');
  owner.child.kill('SIGKILL');
  await exited;
  const next = context.manager('second');
  expect(await next.openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'RECOVERY_REQUIRED',
  });
  await waitForFile(join(repository, 'child-done'));
  expect(
    execFileSync('git', ['-C', repository, 'config', '--local', 'crw.child'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe('survived');
  expect(await context.manager('third').openPrivateStore()).toMatchObject({ status: 'recovery' });
});

test('orphan registration, corrupt database and newer protocol are preserved for recovery', async () => {
  const orphan = await fixture();
  await mkdir(join(orphan.home, '.code-review-workbench'), { mode: 0o700 });
  expect(await orphan.manager('orphan').openPrivateStore()).toMatchObject({ status: 'recovery' });
  const context = await fixture();
  const first = context.manager('first');
  const opened = await first.openPrivateStore();
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const database = join(opened.root!, 'review.sqlite');
  await writeFile(database, 'damaged database');
  expect(await context.manager('second').openPrivateStore()).toMatchObject({ status: 'recovery' });
  expect(await readFile(database, 'utf8')).toBe('damaged database');
  const newer = await fixture();
  const owner = newer.manager('owner');
  expect(await owner.openPrivateStore()).toMatchObject({ status: 'owned' });
  expect(await owner.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const registry = join(newer.home, '.code-review-workbench', 'store-location.json');
  const future = { ...JSON.parse(await readFile(registry, 'utf8')), protocol: 2 };
  await writeFile(registry, JSON.stringify(future));
  expect(await newer.manager('old-version').openPrivateStore()).toMatchObject({
    status: 'recovery',
    code: 'NEWER_PROTOCOL',
  });
  expect(JSON.parse(await readFile(registry, 'utf8'))).toEqual(future);
});

test('a retried request commits once, and an old callback cannot release its successor', async () => {
  const context = await fixture();
  let old: StoreRequest;
  const first = context.manager('first', 'data-A', undefined, (connection) => ({
    ...connection,
    async request(request) {
      const reply = await connection.request(request);
      if (request.action === 'renew' || request.action === 'release') {
        expect(await connection.request(request)).toEqual(reply);
        old = request;
      }
      return reply;
    },
  }));
  const opened = await first.openPrivateStore();
  const saved = await first.renewOwnership();
  expect(saved).toMatchObject({ status: 'owned', revision: opened.revision! + 1 });
  expect(await first.releasePrivateStore()).toMatchObject({ status: 'closed' });
  const second = context.manager('second');
  expect(await second.openPrivateStore()).toMatchObject({ status: 'owned', fence: 2 });
  // Replaying the old release receipt cannot close the new owner's OS handle.
  await context.connections.get('first')!.request(old!);
  expect(await context.manager('third').openPrivateStore()).toMatchObject({ status: 'busy' });
  expect(await second.releasePrivateStore()).toMatchObject({ status: 'closed' });
});

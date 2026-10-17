import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type {
  StoreConfiguration,
  StoreLease,
  StoreReply,
  StoreRequest,
  StoreView,
} from '../application/private-store';
import { StoreError } from '../application/private-store';
import {
  accountScope,
  claimDatabase,
  initializeDatabase,
  metadata,
  openDatabase,
  previousReply,
  requestDigest,
  saveReply,
  transaction,
} from './store-database';
import {
  object,
  publish,
  readControl,
  readRegistry,
  recovery,
  text,
  uuid,
  type NativeStore,
  type StoreControl,
  type StoreRegistry,
} from './store-records';

const native = createRequire(__filename)(join(__dirname, 'native-guard.node')) as NativeStore;

function configuration(value: unknown): StoreConfiguration {
  if (
    !object(value) ||
    !text(value.osHome) ||
    !isAbsolute(value.osHome) ||
    !text(value.candidateRoot) ||
    !isAbsolute(value.candidateRoot) ||
    !text(value.windowId, 128) ||
    !text(value.location) ||
    !isAbsolute(value.location)
  )
    throw new StoreError(
      'INVALID_CONFIGURATION',
      'Storage needs host-owned absolute local paths and a window identity.',
    );
  if (
    value.actor !== undefined &&
    (!object(value.actor) || value.actor.host !== 'github.com' || !text(value.actor.userId, 128))
  ) {
    throw new StoreError(
      'INVALID_ACCOUNT',
      'Storage needs the host-verified immutable GitHub account identity.',
    );
  }
  return value as unknown as StoreConfiguration;
}

function ensureParents(path: string) {
  if (existsSync(path)) {
    native.assertLocalDirectory(path);
    return;
  }
  ensureParents(dirname(path));
  native.ensurePrivateDirectory(path);
}

class SharedStore {
  private readonly rendezvous: string;
  private guard: { readonly created: boolean } | null = null;
  private registry: StoreRegistry | undefined;
  private control: StoreControl | undefined;
  private database: DatabaseSync | undefined;
  private lease: StoreLease | undefined;
  private poisoned = false;
  private terminal: { id: string; digest: string; reply: StoreReply } | undefined;

  constructor(private readonly config: StoreConfiguration) {
    this.rendezvous = join(config.osHome, '.code-review-workbench');
  }

  private registryPath() {
    return join(this.rendezvous, 'store-location.json');
  }
  private controlPath() {
    return join(this.rendezvous, 'control.json');
  }
  private saveControl(control: StoreControl) {
    if (!this.guard) recovery('Independent publication requires the live OS guard.');
    native.assertHeld(this.guard);
    publish(native, this.rendezvous, 'control.json', control);
    this.control = control;
  }

  private busy(): StoreReply {
    const registry = readRegistry(this.registryPath());
    if (!registry) recovery('Canonical registration is incomplete.');
    const control = readControl(this.controlPath(), registry);
    if (!control.owner) recovery('Store release or registration is incomplete.');
    if (
      control.pending &&
      native.processIdentity(control.owner.process.pid)?.start !== control.owner.process.start
    ) {
      recovery(
        'An interrupted Git operation remains unconfirmed. The prior child may still run; preserve its recovery record.',
      );
    }
    return {
      view: {
        status: 'busy',
        ownerLocation: control.owner.location,
        detail: `The private store is owned by the window at ${control.owner.location}. Return to that window or release it there.`,
      },
    };
  }

  inspect(): StoreReply {
    if (this.lease && this.guard) {
      this.validate(this.lease, false);
      return this.owned();
    }
    if (!existsSync(this.rendezvous))
      return {
        view: {
          status: 'closed',
          detail:
            'The shared private store has not been opened. Use Open Private Store when ready.',
        },
      };
    native.assertPrivateDirectory(this.rendezvous);
    const registry = readRegistry(this.registryPath());
    if (!registry) recovery('Canonical registration is incomplete.');
    const control = readControl(this.controlPath(), registry);
    if (control.phase === 'released')
      return {
        view: {
          status: 'closed',
          root: registry.root,
          detail: 'The shared private store is released. Use Open Private Store to claim it.',
        },
      };
    return this.busy();
  }

  private initialize(): StoreRegistry {
    const root = this.config.candidateRoot;
    this.assertOutsideRepository(root);
    // A root left by another initialization is recovery, even when it looks
    // empty. The fixed rendezvous must never silently register a second store.
    if (existsSync(root)) recovery('Storage already exists without a canonical registration.');
    ensureParents(dirname(root));
    native.ensurePrivateDirectory(root);
    const registry: StoreRegistry = {
      protocol: 1,
      root,
      storeId: randomUUID(),
      incarnation: randomUUID(),
      localScopeId: randomUUID(),
    };
    const identity = native.processIdentity(process.pid);
    if (!identity) recovery('The current host process identity is unavailable.');
    publish(native, this.rendezvous, 'bootstrap.json', registry);
    publish(native, this.rendezvous, 'store-location.json', registry);
    this.saveControl({
      protocol: 1,
      storeId: registry.storeId,
      incarnation: registry.incarnation,
      fence: 0,
      revision: 0,
      phase: 'initializing',
      owner: {
        token: randomUUID(),
        scopeId: registry.localScopeId,
        windowId: this.config.windowId,
        location: this.config.location,
        process: identity,
        heartbeat: Date.now(),
      },
    });
    const database = initializeDatabase(join(root, 'review.sqlite'), registry);
    database.close();
    this.saveControl({ ...this.control!, phase: 'released', owner: null });
    return registry;
  }

  private assertOutsideRepository(root: string) {
    const inside = relative(this.config.location, root);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)))
      throw new StoreError('UNSUPPORTED_ROOT', 'The private store must be outside the repository.');
    for (let current = root; ; current = dirname(current)) {
      if (existsSync(join(current, '.git')))
        throw new StoreError('UNSUPPORTED_ROOT', 'The private store must be outside repositories.');
      if (current === dirname(current)) break;
    }
  }

  open(request: StoreRequest): StoreReply {
    if (this.poisoned)
      recovery('An earlier storage outcome is uncertain; close this window before recovery.');
    if (this.guard) {
      if (this.lease) {
        this.validate(this.lease, false);
        return this.owned();
      }
      recovery('This window holds an incomplete storage claim.');
    }
    native.assertLocalDirectory(this.config.osHome);
    // Serialize before directory creation too. A mkdir followed by flock has
    // a gap where a contender can arrive before the creating process locks.
    this.guard = native.tryAcquire(join(this.config.osHome, '.code-review-workbench.guard'));
    if (!this.guard) return this.busy();
    const created = native.ensurePrivateDirectory(this.rendezvous);
    let registry = readRegistry(this.registryPath(), true);
    if (!registry) {
      if (!created || !this.guard.created || readdirSync(this.rendezvous).length !== 0)
        recovery('An orphan or incomplete ownership guard needs explicit recovery.');
      registry = this.initialize();
    }
    this.registry = registry;
    this.assertOutsideRepository(registry.root);
    if (!existsSync(registry.root)) recovery('The registered private store is missing.');
    native.assertLocalDirectory(registry.root);
    native.ensurePrivateDirectory(registry.root);
    const control = readControl(this.controlPath(), registry);
    if (control.pending)
      recovery(
        'A previous Git operation has an unconfirmed outcome. Its child may still run. Reconcile the repository before explicit recovery.',
      );
    if (!['owned', 'released', 'handoff'].includes(control.phase))
      recovery('An interrupted ownership transition needs explicit recovery.');
    if (
      control.phase === 'handoff' &&
      (!request.handoff ||
        request.handoff.token !== control.handoff?.token ||
        request.handoff.storeId !== registry.storeId ||
        request.handoff.incarnation !== registry.incarnation ||
        request.handoff.fence !== control.fence ||
        control.handoff?.targetWindowId !== this.config.windowId)
    ) {
      native.release(this.guard);
      this.guard = null;
      throw new StoreError(
        'HANDOFF_PENDING',
        'Ownership is reserved for the named handoff window. Return there to finish the handoff; no timeout takeover is allowed.',
      );
    }
    if (control.owner) {
      const previous = native.processIdentity(control.owner.process.pid);
      if (previous?.start === control.owner.process.start)
        recovery(
          `The prior owner at ${control.owner.location} may still run. Close its window before retrying.`,
        );
    }
    this.database = openDatabase(join(registry.root, 'review.sqlite'), registry, control);
    const identity = native.processIdentity(process.pid);
    if (!identity || control.fence === Number.MAX_SAFE_INTEGER)
      recovery('A new verified owner generation is unavailable.');
    const owner = {
      token: randomUUID(),
      scopeId: accountScope(this.database, registry, this.config.actor),
      windowId: this.config.windowId,
      location: this.config.location,
      process: identity,
      heartbeat: Date.now(),
    };
    const { handoff: _handoff, ...nextControl } = control;
    this.saveControl({ ...nextControl, phase: 'claiming', owner, fence: control.fence + 1 });
    const revision = claimDatabase(
      this.database,
      registry,
      owner,
      this.config,
      control.fence + 1,
      () => {
        native.assertHeld(this.guard!);
        const registered = readRegistry(this.registryPath());
        if (
          !registered ||
          registered.storeId !== registry.storeId ||
          registered.incarnation !== registry.incarnation ||
          registered.root !== registry.root
        )
          recovery('The canonical registration changed during claim.');
        const claiming = readControl(this.controlPath(), registered);
        if (
          claiming.phase !== 'claiming' ||
          claiming.owner?.token !== owner.token ||
          claiming.fence !== control.fence + 1
        )
          recovery('The ownership claim changed before commit.');
      },
    );
    this.saveControl({ ...this.control!, phase: 'owned', revision });
    this.lease = {
      token: owner.token,
      scopeId: owner.scopeId,
      storeId: registry.storeId,
      incarnation: registry.incarnation,
      fence: control.fence + 1,
      revision,
    };
    return this.owned();
  }

  private owned(): StoreReply {
    if (!this.registry || !this.control?.owner || !this.lease)
      recovery('The owner projection is unavailable.');
    const view: StoreView = {
      status: 'owned',
      detail: 'This window owns the shared private store.',
      root: this.registry.root,
      storeId: this.registry.storeId,
      incarnation: this.registry.incarnation,
      fence: this.lease.fence,
      revision: this.lease.revision,
      scopeId: this.lease.scopeId,
      process: this.control.owner.process,
      ownerLocation: this.control.owner.location,
    };
    return { view, lease: this.lease };
  }

  private validate(
    lease: StoreLease | undefined,
    revision: boolean,
    phase: StoreControl['phase'] = 'owned',
  ) {
    if (
      this.poisoned ||
      !this.guard ||
      !this.registry ||
      !this.lease ||
      !this.database ||
      !lease ||
      lease.token !== this.lease.token ||
      lease.scopeId !== this.lease.scopeId ||
      lease.incarnation !== this.lease.incarnation ||
      lease.storeId !== this.lease.storeId ||
      lease.fence !== this.lease.fence
    ) {
      throw new StoreError(
        'STALE_LEASE',
        'This request does not own the current store generation.',
      );
    }
    native.assertHeld(this.guard);
    const registry = readRegistry(this.registryPath());
    if (
      !registry ||
      registry.root !== this.registry.root ||
      registry.storeId !== this.lease.storeId ||
      registry.incarnation !== this.lease.incarnation
    )
      recovery('The canonical store identity changed.');
    const control = readControl(this.controlPath(), registry);
    const meta = metadata(this.database);
    if (
      control.phase !== phase ||
      control.owner?.token !== lease.token ||
      control.fence !== lease.fence ||
      meta.incarnation !== lease.incarnation ||
      meta.storeId !== lease.storeId ||
      meta.fence !== lease.fence
    ) {
      throw new StoreError(
        'STALE_LEASE',
        'The independent record or database has fenced this owner.',
      );
    }
    if (native.processIdentity(process.pid)?.start !== control.owner.process.start)
      recovery('The owner process identity changed.');
    if (meta.revision !== control.revision)
      recovery('The database and independent revision disagree.');
    if (revision && lease.revision !== meta.revision)
      throw new StoreError(
        'REVISION_CONFLICT',
        'Private-store metadata changed; this request was not committed.',
      );
    this.control = control;
  }

  private mutate(request: StoreRequest): StoreReply {
    this.validate(request.lease, false);
    const previous = previousReply(this.database!, request);
    if (previous) return previous;
    this.validate(request.lease, true);
    if (this.lease!.revision === Number.MAX_SAFE_INTEGER)
      recovery('The metadata sequence is exhausted.');
    if (this.control!.pending)
      recovery('A Git operation remains unconfirmed; release and other writes are unavailable.');
    const lease = { ...this.lease!, revision: this.lease!.revision + 1 };
    const releasing = request.action === 'release' || request.action === 'handoff';
    if (request.action === 'handoff' && !text(request.targetWindowId, 128))
      throw new StoreError(
        'INVALID_REQUEST',
        'A handoff needs a host-owned target window identity.',
      );
    const handoff =
      request.action === 'handoff'
        ? {
            token: randomUUID(),
            targetWindowId: request.targetWindowId!,
            storeId: lease.storeId,
            incarnation: lease.incarnation,
            fence: lease.fence,
          }
        : undefined;
    const reply: StoreReply = releasing
      ? { view: { status: 'closed', detail: 'The shared private store was durably released.' } }
      : { ...this.owned(), lease, view: { ...this.owned().view, revision: lease.revision } };
    if (handoff) reply.handoff = handoff;
    if (releasing) this.saveControl({ ...this.control!, phase: 'releasing' });
    transaction(this.database!, () => {
      // Revalidate canonical identity/fence inside every mutation transaction.
      this.validate(request.lease, true, releasing ? 'releasing' : 'owned');
      this.database!.prepare('UPDATE metadata SET revision=revision+1 WHERE id=1').run();
      this.database!.prepare(
        'UPDATE ownership SET heartbeat=?,active=? WHERE token=? AND scope_id=?',
      ).run(Date.now(), releasing ? 0 : 1, lease.token, lease.scopeId);
      saveReply(this.database!, request, lease, reply);
    });
    this.lease = lease;
    if (releasing) {
      this.saveControl({
        ...this.control!,
        phase: handoff ? 'handoff' : 'released',
        revision: lease.revision,
        owner: null,
        ...(handoff ? { handoff } : {}),
      });
      this.database!.close();
      this.database = undefined;
      if (!native.release(this.guard!)) recovery('The OS did not confirm release.');
      this.guard = null;
      this.lease = undefined;
      this.terminal = { id: request.id, digest: requestDigest(request), reply };
    } else
      this.saveControl({
        ...this.control!,
        revision: lease.revision,
        owner: { ...this.control!.owner!, heartbeat: Date.now() },
      });
    return reply;
  }

  private async git(request: StoreRequest): Promise<StoreReply> {
    this.validate(request.lease, false);
    const previous = previousReply(this.database!, request);
    if (previous) return previous;
    this.validate(request.lease, true);
    if (this.control!.pending)
      recovery('A previous Git operation needs reconciliation before another can run.');
    if (
      !Array.isArray(request.args) ||
      request.args.length === 0 ||
      request.args.length > 128 ||
      !request.args.every(
        (arg) => typeof arg === 'string' && arg.length <= 32768 && !arg.includes('\0'),
      )
    ) {
      throw new StoreError('INVALID_REQUEST', 'Git needs bounded host-owned arguments.');
    }
    native.assertLocalDirectory(this.config.location);
    this.validate(request.lease, true);
    const paths = execFileSync(
      'git',
      [
        '-C',
        this.config.location,
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
      ],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true },
    )
      .trimEnd()
      .split(/\r?\n/);
    if (paths.length !== 2 || paths[0] !== this.config.location)
      recovery('The repository location changed or is unsupported.');
    const scopes = paths
      .map((path) => {
        native.assertLocalDirectory(path);
        const identity = statSync(path, { bigint: true });
        return `${identity.dev}:${identity.ino}:${path}`;
      })
      .sort();
    const pending: NonNullable<StoreControl['pending']> = {
      id: request.id,
      scopeId: this.lease!.scopeId,
      scopes,
      child: null,
    };
    const advance = (write: () => void) => {
      transaction(this.database!, () => {
        this.validate(this.lease, true);
        write();
        this.database!.prepare('UPDATE metadata SET revision=revision+1 WHERE id=1').run();
      });
      this.lease = { ...this.lease!, revision: this.lease!.revision + 1 };
    };
    advance(() =>
      this.database!.prepare(
        "INSERT INTO operations VALUES (?,?,?,?,'pending',NULL,NULL,NULL)",
      ).run(request.id, this.lease!.token, this.lease!.scopeId, JSON.stringify(scopes)),
    );
    this.saveControl({ ...this.control!, revision: this.lease!.revision, pending });
    // All operations use this one ordered worker queue. The two canonical
    // scopes are sorted before reserving them; linked worktrees share the
    // common-Git-directory scope. Never hold a SQL transaction across Git.
    this.validate(this.lease, true);
    paths.forEach((path, index) => {
      native.assertLocalDirectory(path);
      const identity = statSync(path, { bigint: true });
      if (!scopes.includes(`${identity.dev}:${identity.ino}:${path}`))
        recovery(`Repository scope ${index} was replaced.`);
    });
    this.validate(this.lease, true);
    const child = spawn('git', ['-C', this.config.location, ...request.args], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        // A stop request is not evidence that a child/descendant stopped.
        child.kill();
        reject(
          new StoreError(
            'OPERATION_UNKNOWN',
            'Git timed out. Its outcome and child lifetime need reconciliation; ownership is retained.',
          ),
        );
      }, 8000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (code === null || signal)
          reject(
            new StoreError(
              'OPERATION_UNKNOWN',
              'Git stopped without a known result; recovery remains required.',
            ),
          );
        else resolveExit(code);
      });
      child.once('spawn', () => {
        try {
          const identity = native.processIdentity(child.pid!);
          if (identity) {
            advance(() =>
              this.database!.prepare(
                'UPDATE operations SET pid=?,process_start=? WHERE operation_id=? AND owner_token=? AND scope_id=?',
              ).run(
                identity.pid,
                identity.start,
                request.id,
                this.lease!.token,
                this.lease!.scopeId,
              ),
            );
            pending.child = identity;
            this.saveControl({ ...this.control!, revision: this.lease!.revision, pending });
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    const finalLease = { ...this.lease!, revision: this.lease!.revision + 1 };
    const reply: StoreReply = {
      ...this.owned(),
      lease: finalLease,
      view: { ...this.owned().view, revision: finalLease.revision },
      git: { exitCode },
    };
    advance(() => {
      this.database!.prepare(
        "UPDATE operations SET phase='complete',exit_code=? WHERE operation_id=? AND owner_token=? AND scope_id=?",
      ).run(exitCode, request.id, this.lease!.token, this.lease!.scopeId);
      saveReply(this.database!, request, finalLease, reply);
    });
    const { pending: _pending, ...completed } = this.control!;
    this.saveControl({ ...completed, revision: finalLease.revision });
    return reply;
  }

  async dispatch(message: unknown): Promise<StoreReply> {
    if (
      !object(message) ||
      message.protocol !== 1 ||
      !uuid(message.id) ||
      !['open', 'inspect', 'release', 'renew', 'handoff', 'git'].includes(String(message.action))
    )
      throw new StoreError('INVALID_REQUEST', 'Unsupported storage request.');
    const request = message as unknown as StoreRequest;
    try {
      if (request.action === 'inspect') return this.inspect();
      if (request.action === 'open') return this.open(request);
      if (request.action === 'git') return await this.git(request);
      if (this.terminal?.id === request.id) {
        if (this.terminal.digest !== requestDigest(request))
          throw new StoreError(
            'REQUEST_COLLISION',
            'A completed request ID was reused with different content.',
          );
        return this.terminal.reply;
      }
      return this.mutate(request);
    } catch (error) {
      if (
        !(error instanceof StoreError) ||
        !['STALE_LEASE', 'REVISION_CONFLICT', 'REQUEST_COLLISION', 'HANDOFF_PENDING'].includes(
          error.code,
        )
      )
        this.poisoned = true;
      throw error;
    }
  }
}

const store = new SharedStore(configuration(workerData));
let queue = Promise.resolve();
parentPort!.on('message', (message: unknown) => {
  queue = queue.then(async () => {
    const id = object(message) && typeof message.id === 'string' ? message.id : '';
    try {
      parentPort!.postMessage({ id, reply: await store.dispatch(message) });
    } catch (error) {
      const known = error instanceof StoreError;
      parentPort!.postMessage({
        id,
        error: {
          code: known ? error.code : 'STORE_UNAVAILABLE',
          message: known
            ? error.message
            : 'The private store could not complete this action. Preserve the store and recovery records; no replacement was created.',
        },
      });
    }
  });
});

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
    publish(native, this.rendezvous, 'control.json', control);
    this.control = control;
  }

  private busy(): StoreReply {
    const registry = readRegistry(this.registryPath());
    if (!registry) recovery('Canonical registration is incomplete.');
    const control = readControl(this.controlPath(), registry);
    if (!control.owner) recovery('Store release or registration is incomplete.');
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
    native.assertLocalDirectory(this.rendezvous);
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
    if (!existsSync(registry.root)) recovery('The registered private store is missing.');
    native.assertLocalDirectory(registry.root);
    native.ensurePrivateDirectory(registry.root);
    const control = readControl(this.controlPath(), registry);
    if (!['owned', 'released', 'handoff'].includes(control.phase))
      recovery('An interrupted ownership transition needs explicit recovery.');
    if (
      control.phase === 'handoff' &&
      (!request.handoff ||
        JSON.stringify(request.handoff) !== JSON.stringify(control.handoff) ||
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
    const revision = claimDatabase(this.database, registry, owner, this.config, control.fence + 1);
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

  dispatch(message: unknown): StoreReply {
    if (
      !object(message) ||
      message.protocol !== 1 ||
      !uuid(message.id) ||
      !['open', 'inspect', 'release', 'renew', 'handoff'].includes(String(message.action))
    )
      throw new StoreError('INVALID_REQUEST', 'Unsupported storage request.');
    const request = message as unknown as StoreRequest;
    try {
      if (request.action === 'inspect') return this.inspect();
      if (request.action === 'open') return this.open(request);
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
parentPort!.on('message', (message: unknown) => {
  const id = object(message) && typeof message.id === 'string' ? message.id : '';
  try {
    parentPort!.postMessage({ id, reply: store.dispatch(message) });
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

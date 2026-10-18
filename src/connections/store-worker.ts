import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import {
  RepositoryOperation,
  assertOperationOwner,
  readOperation,
  operationFile,
  type OperationRecord,
} from './repository-operation';

import { StorageFaults } from './storage-diagnostics';
import { normalizeCandidate, type ReviewCandidate } from '../application/pull-request';

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
  private actor: StoreConfiguration['actor'];
  private readonly rendezvous: string;
  private guard: { readonly created: boolean } | null = null;
  private registry: StoreRegistry | undefined;
  private control: StoreControl | undefined;
  private database: DatabaseSync | undefined;
  private lease: StoreLease | undefined;
  private poisoned = false;
  private recoveryOwner = false;
  private readonly faults = new StorageFaults(
    object(workerData) ? workerData.storageDiagnostics : undefined,
  );
  private terminal: { id: string; digest: string; reply: StoreReply } | undefined;

  constructor(private readonly config: StoreConfiguration) {
    this.rendezvous = join(config.osHome, '.code-review-workbench');
    this.actor = config.actor;
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
    if (
      request.actor &&
      (request.actor.host !== 'github.com' || !/^[1-9]\d{0,19}$/.test(request.actor.userId))
    )
      throw new StoreError('INVALID_ACCOUNT', 'An immutable verified GitHub account is required.');
    if (this.guard) {
      if (this.lease) {
        if (request.actor && request.actor.userId !== this.actor?.userId)
          throw new StoreError(
            'WRONG_ACCOUNT',
            'Release the original owner explicitly before claiming another account.',
          );
        this.validate(this.lease, false);
        return this.owned();
      }
      recovery('This window holds an incomplete storage claim.');
    }
    this.actor = request.actor
      ? { host: 'github.com', userId: request.actor.userId }
      : this.config.actor;
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
      scopeId: accountScope(this.database, registry, this.actor),
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
      { ...this.config, ...(this.actor ? { actor: this.actor } : {}) },
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
      status: this.control.pending ? 'recovery' : 'owned',
      detail: this.control.pending
        ? 'A repository operation is pending. Use recovery to check its process and actual outcome before release.'
        : 'This window owns the shared private store.',
      ...(this.control.pending ? { code: 'OPERATION_PENDING' } : {}),
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
    native.assertPrivateDirectory(this.rendezvous);
    native.assertPrivateDirectory(this.registry.root);
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
    if (
      this.recoveryOwner
        ? native.processIdentity(control.owner.process.pid)?.start === control.owner.process.start
        : native.processIdentity(process.pid)?.start !== control.owner.process.start
    )
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

  private mutate(request: StoreRequest, operation?: StoreReply['operation']): StoreReply {
    // Recovery already validated the caller and reconciled one operation. Its
    // internal receipt publication advanced the lease before this release.
    const authorization =
      this.recoveryOwner || request.action === 'recover' ? this.lease : request.lease;
    this.validate(authorization, false);
    const previous = previousReply(this.database!, request, authorization);
    if (previous) return previous;
    this.validate(authorization, true);
    if (this.lease!.revision === Number.MAX_SAFE_INTEGER)
      recovery('The metadata sequence is exhausted.');
    if (this.control!.pending)
      recovery('A Git operation remains unconfirmed; release and other writes are unavailable.');
    const lease = { ...this.lease!, revision: this.lease!.revision + 1 };
    const releasing =
      request.action === 'release' || request.action === 'handoff' || request.action === 'recover';
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
    if (operation) reply.operation = operation;
    if (releasing) this.saveControl({ ...this.control!, phase: 'releasing' });
    transaction(this.database!, () => {
      // Revalidate canonical identity/fence inside every mutation transaction.
      this.validate(authorization, true, releasing ? 'releasing' : 'owned');
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

  private recordIntent(request: StoreRequest): StoreReply {
    this.validate(request.lease, false);
    const previous = previousReply(this.database!, request);
    if (previous) return previous;
    this.validate(request.lease, true);
    if (this.control!.pending)
      recovery(
        'A repository operation is already pending. Reconcile it before recording another intent.',
      );
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
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 65536,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
    )
      .trimEnd()
      .split(/\r?\n/)
      .map((path) => normalize(path));
    if (paths.length !== 2 || paths[0] !== this.config.location)
      recovery('The repository location changed or is unsupported.');
    const scopes = paths
      .map((path) => {
        native.assertLocalDirectory(path);
        const identity = statSync(path, { bigint: true });
        return `${identity.dev}:${identity.ino}:${path}`;
      })
      .sort();
    this.validate(request.lease, true);
    // Independent intent precedes its SQLite projection. A crash at either
    // boundary leaves the store blocked, never permission to dispatch or replay.
    const pending: NonNullable<StoreControl['pending']> = {
      id: request.id,
      scopeId: this.lease!.scopeId,
      scopes,
      child: null,
    };
    this.saveControl({ ...this.control!, pending });
    const lease = { ...this.lease!, revision: this.lease!.revision + 1 };
    const reply: StoreReply = {
      view: {
        ...this.owned().view,
        status: 'recovery',
        code: 'OPERATION_PENDING',
        detail:
          'Untyped repository intent is recorded. It cannot authorize execution or automatic recovery; preserve its recovery records.',
        revision: lease.revision,
      },
      lease,
      reservation: { id: request.id, scopes },
    };
    transaction(this.database!, () => {
      this.validate(request.lease, true);
      this.database!.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(
        request.id,
        lease.token,
        lease.scopeId,
        JSON.stringify(scopes),
      );
      this.database!.prepare('UPDATE metadata SET revision=revision+1 WHERE id=1').run();
      saveReply(this.database!, request, lease, reply);
    });
    this.lease = lease;
    this.saveControl({ ...this.control!, revision: lease.revision });
    return reply;
  }

  private saveCandidate(request: StoreRequest): StoreReply {
    this.validate(request.lease, false);
    const previous = previousReply(this.database!, request);
    if (previous) return previous;
    this.validate(request.lease, true);
    let candidate: ReviewCandidate;
    try {
      candidate = normalizeCandidate(request.candidate);
    } catch {
      throw new StoreError(
        'INVALID_CANDIDATE',
        'The PR candidate is malformed or exceeds the supported size. Saved work is unchanged.',
      );
    }
    if (candidate.account.userId !== this.actor?.userId)
      throw new StoreError('WRONG_ACCOUNT', 'This account does not own the private store.');
    if (this.control!.pending)
      throw new StoreError(
        'OPERATION_UNAVAILABLE',
        'Reconcile the pending repository operation before saving a PR candidate.',
      );
    if (this.lease!.revision === Number.MAX_SAFE_INTEGER)
      recovery('The metadata sequence is exhausted.');
    const local = candidate.localRepository;
    const requested = statSync(local.facts.worktree.path, { bigint: true });
    const configured = statSync(this.config.location, { bigint: true });
    if (
      !requested.isDirectory() ||
      requested.dev !== configured.dev ||
      requested.ino < 1n ||
      requested.ino !== configured.ino
    ) {
      throw new StoreError(
        'WORKSPACE_CHANGED',
        'The selected local repository changed before its mapping could be saved.',
      );
    }
    for (const identity of [
      local.facts.worktree,
      local.facts.gitDirectory,
      local.facts.commonDirectory,
    ]) {
      native.assertLocalDirectory(identity.path);
      const current = statSync(identity.path, { bigint: true });
      if (String(current.dev) !== identity.device || String(current.ino) !== identity.inode)
        throw new StoreError(
          'WORKSPACE_CHANGED',
          'The registered repository directories were replaced. Saved work is unchanged.',
        );
    }
    const existing = this.database!.prepare(
      `SELECT result FROM requests
      WHERE scope_id=? AND action='saveCandidate'
      AND json_extract(result,'$.candidate.localRepository.facts.worktree.path')=?
      ORDER BY rowid DESC LIMIT 1`,
    ).get(this.lease!.scopeId, local.facts.worktree.path);
    if (existing) {
      const prior = normalizeCandidate(JSON.parse(String(existing.result)).candidate);
      if (
        prior.localRepository.repositoryId !== local.repositoryId ||
        JSON.stringify(prior.localRepository.facts.worktree) !==
          JSON.stringify(local.facts.worktree) ||
        JSON.stringify(prior.localRepository.facts.gitDirectory) !==
          JSON.stringify(local.facts.gitDirectory) ||
        JSON.stringify(prior.localRepository.facts.commonDirectory) !==
          JSON.stringify(local.facts.commonDirectory)
      ) {
        throw new StoreError(
          'REGISTRATION_CHANGED',
          'The selected copy was previously registered to different immutable repository or directory identities. A reused name or replaced copy cannot inherit that registration. Saved work is retained; select its original copy.',
        );
      }
    }
    const lease = { ...this.lease!, revision: this.lease!.revision + 1 };
    const reply: StoreReply = {
      view: { ...this.owned().view, revision: lease.revision },
      lease,
      candidate,
    };
    transaction(this.database!, () => {
      this.validate(request.lease, true);
      // The existing durable receipt journal is the candidate record. No schema
      // change or unversioned lazy table is introduced for this narrow slice.
      this.database!.prepare('UPDATE metadata SET revision=revision+1 WHERE id=1').run();
      this.database!.prepare('UPDATE ownership SET heartbeat=? WHERE token=? AND scope_id=?').run(
        Date.now(),
        lease.token,
        lease.scopeId,
      );
      saveReply(this.database!, request, lease, reply);
    });
    this.lease = lease;
    this.saveControl({
      ...this.control!,
      revision: lease.revision,
      owner: { ...this.control!.owner!, heartbeat: Date.now() },
    });
    return reply;
  }

  private readCandidate(request: StoreRequest): StoreReply {
    this.validate(request.lease, true);
    const key = request.candidateKey;
    if (
      !key ||
      !/^[1-9]\d{0,19}$/.test(key.baseRepositoryId) ||
      !Number.isSafeInteger(key.pullNumber) ||
      key.pullNumber < 1
    )
      throw new StoreError(
        'INVALID_CANDIDATE',
        'A verified repository ID and PR number are required.',
      );
    const row = this.database!.prepare(
      `SELECT result FROM requests WHERE scope_id=? AND action='saveCandidate'
      AND json_extract(result,'$.candidate.pullRequest.base.repository.id')=?
      AND json_extract(result,'$.candidate.pullRequest.number')=? ORDER BY rowid DESC LIMIT 1`,
    ).get(this.lease!.scopeId, key.baseRepositoryId, key.pullNumber);
    return {
      ...this.owned(),
      ...(row ? { candidate: normalizeCandidate(JSON.parse(String(row.result)).candidate) } : {}),
    };
  }

  private repository(location = this.config.location) {
    const hooks = join(this.rendezvous, 'no-hooks');
    native.ensurePrivateDirectory(hooks);
    if (readdirSync(hooks).length !== 0) recovery('The protected no-hooks directory is not empty.');
    return new RepositoryOperation(location, hooks, native);
  }

  private projectOperation(record: OperationRecord, request?: StoreRequest): StoreReply {
    this.validate(this.lease, true);
    if (this.lease!.revision === Number.MAX_SAFE_INTEGER)
      recovery('The metadata sequence is exhausted.');
    assertOperationOwner(record, this.lease!);
    // Receipt/intent first; SQLite is its projection, never evidence that an
    // external effect completed. The independent receipt is retained.
    this.faults.publish(record.phase, native, operationFile(this.rendezvous, record.id), record);
    const pending = {
      id: record.id,
      scopeId: record.scopeId,
      scopes: record.facts.scopes,
      child: record.child,
    };
    this.faults.at(`${record.phase}.barrier.before`);
    this.saveControl({ ...this.control!, pending });
    this.faults.at(`${record.phase}.barrier.after`);
    const lease = { ...this.lease!, revision: this.lease!.revision + 1 };
    const observed = record.phase === 'observed';
    const reply: StoreReply = {
      lease,
      view: {
        ...this.owned().view,
        status: observed ? 'owned' : 'recovery',
        detail: observed
          ? `Repository outcome was verified and durably recorded.${record.exitCode !== undefined ? ` Git exited with code ${record.exitCode}.` : ''}`
          : 'Repository operation is pending; release and handoff are blocked.',
        revision: lease.revision,
        ...(observed ? {} : { code: 'OPERATION_PENDING' }),
      },
      operation: {
        id: record.id,
        phase: record.phase,
        ...(record.outcome ? { outcome: record.outcome } : {}),
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      },
    };
    if (observed) delete reply.view.code;
    this.faults.at(`${record.phase}.commit.before`, this.database);
    transaction(this.database!, () => {
      this.validate(this.lease, true);
      this.database!.exec(
        'CREATE TABLE IF NOT EXISTS operation_records (operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id), record TEXT NOT NULL) STRICT',
      );
      const existing = this.database!.prepare(
        'SELECT owner_token,scope_id FROM operations WHERE operation_id=?',
      ).get(record.id);
      if (
        existing &&
        (existing.owner_token !== record.ownerToken || existing.scope_id !== record.scopeId)
      )
        throw new StoreError(
          'REQUEST_COLLISION',
          'The operation identity belongs to another owner scope.',
        );
      this.database!.prepare('INSERT OR IGNORE INTO operations VALUES (?,?,?,?)').run(
        record.id,
        record.ownerToken,
        record.scopeId,
        JSON.stringify(record.facts.scopes),
      );
      this.database!.prepare(
        'INSERT INTO operation_records VALUES (?,?) ON CONFLICT(operation_id) DO UPDATE SET record=excluded.record',
      ).run(record.id, JSON.stringify(record));
      this.database!.prepare('UPDATE metadata SET revision=revision+1 WHERE id=1').run();
      if (request) saveReply(this.database!, request, lease, reply);
    });
    this.faults.at(`${record.phase}.commit.after`);
    this.lease = lease;
    const { pending: _pending, ...control } = this.control!;
    this.faults.at(`${record.phase}.ack.before`);
    this.saveControl({ ...control, revision: lease.revision, ...(observed ? {} : { pending }) });
    this.faults.at(`${record.phase}.ack.after`);
    return reply;
  }

  private prepareReference(request: StoreRequest) {
    this.validate(request.lease, false);
    const previous = previousReply(this.database!, request);
    if (previous) return previous;
    this.validate(request.lease, true);
    if (this.control!.pending)
      recovery('Reconcile the pending repository operation before preparing another.');
    const repository = this.repository();
    const update = request.refUpdate;
    repository.validateUpdate(update?.ref, update?.newOid);
    const ref = update!.ref,
      newOid = update!.newOid;
    const facts = repository.facts();
    const beforeOid = repository.refOid(ref);
    if (beforeOid === newOid)
      throw new StoreError(
        'INVALID_OPERATION',
        'The reference already has this value. No operation or recovery intent was created.',
      );
    const record: OperationRecord = {
      protocol: 1,
      id: request.id,
      kind: 'update-ref',
      phase: 'prepared',
      storeId: this.lease!.storeId,
      incarnation: this.lease!.incarnation,
      fence: this.lease!.fence,
      ownerToken: this.lease!.token,
      scopeId: this.lease!.scopeId,
      ref,
      newOid,
      beforeOid,
      facts,
      storage: repository.referenceStorage(ref, facts),
      child: null,
    };
    return this.projectOperation(record, request);
  }

  private async executeOperation(request: StoreRequest) {
    this.validate(request.lease, false);
    const previous = previousReply(this.database!, request);
    if (previous) return previous;
    this.validate(request.lease, true);
    if (!uuid(request.operationId) || this.control!.pending?.id !== request.operationId)
      throw new StoreError(
        'INVALID_OPERATION',
        'This request does not identify the pending operation.',
      );
    let record = readOperation(this.rendezvous, request.operationId);
    assertOperationOwner(record, this.lease!);
    if (record.phase !== 'prepared')
      recovery('This operation may already have run. Use recovery; execution is never replayed.');
    if (
      this.control!.pending.child !== null ||
      this.database!.prepare('SELECT record FROM operation_records WHERE operation_id=?').get(
        record.id,
      )?.record !== JSON.stringify(record)
    )
      recovery(
        'Independent intent and database projection disagree. Use recovery; do not dispatch.',
      );
    const repository = this.repository(record.facts.worktree);
    if (
      !repository.sameFacts(record.facts) ||
      !repository.sameReferenceStorage(record) ||
      repository.refOid(record.ref) !== record.beforeOid
    ) {
      return this.projectOperation({ ...record, phase: 'observed', outcome: 'refused' }, request);
    }
    const child = repository.prepare(record);
    try {
      const identity = native.processIdentity(child.pid);
      if (!identity) recovery('The paused Git child has no verified process identity.');
      record = { ...record, phase: 'armed', child: identity };
      this.projectOperation(record);
      this.validate(this.lease, true);
      if (
        !repository.sameFacts(record.facts) ||
        !repository.sameReferenceStorage(record) ||
        repository.refOid(record.ref) !== record.beforeOid
      ) {
        native.cancelPreparedChild(child);
        await this.waitForChild(child);
        return this.projectOperation({ ...record, phase: 'observed', outcome: 'refused' }, request);
      }
      this.validate(this.lease, true);
      this.faults.at('dispatch.before');
      native.startChild(child);
      this.faults.at('dispatch.after');
      const status = await this.waitForChild(child);
      this.validate(this.lease, true);
      const actual = repository.refOid(record.ref);
      if (
        !repository.sameFacts(record.facts) ||
        !repository.sameReferenceStorage(record, true) ||
        (actual !== record.newOid && actual !== record.beforeOid)
      )
        recovery(
          'Repository state changed during Git. Preserve the operation and reconcile its actual outcome.',
        );
      if (status.exitCode !== 0 && actual === record.newOid)
        recovery('Git exit and observed reference disagree; explicit reconciliation is required.');
      return this.projectOperation(
        {
          ...record,
          phase: 'observed',
          outcome: actual === record.newOid ? 'applied' : 'not-applied',
          exitCode: status.exitCode,
        },
        request,
      );
    } finally {
      native.closeChild(child);
    }
  }

  private async waitForChild(child: object) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = native.pollChild(child);
      if (status.settled) {
        if (typeof status.exitCode !== 'number' || !Number.isSafeInteger(status.exitCode))
          recovery('The settled Git child has no verified exit status.');
        return { settled: true, exitCode: status.exitCode };
      }
      if (Date.now() >= deadline)
        recovery(
          'Git or its process group has not settled. Its recorded identity remains protected; use recovery after it stops.',
        );
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }

  private recoverOperation(request: StoreRequest): StoreReply {
    native.assertLocalDirectory(this.config.osHome);
    if (!this.guard)
      this.guard = native.tryAcquire(join(this.config.osHome, '.code-review-workbench.guard'));
    if (!this.guard) return this.busy();
    native.assertHeld(this.guard);
    native.assertPrivateDirectory(this.rendezvous);
    const registry = readRegistry(this.registryPath());
    if (!registry) recovery('Canonical registration is incomplete; no replacement can be created.');
    native.assertPrivateDirectory(registry.root);
    this.registry = registry;
    const control = readControl(this.controlPath(), registry);
    if (control.phase === 'released' && !control.pending) {
      native.release(this.guard);
      this.guard = null;
      return {
        view: {
          status: 'closed',
          detail: 'The store is already released; no operation was replayed.',
        },
      };
    }
    if (control.phase !== 'owned' || !control.owner || !control.pending)
      recovery(
        'Ownership publication is incomplete. Preserve the files; no repository operation can be inferred or replayed.',
      );
    // Another worker in a still-live host is never permission to take over.
    const priorAlive =
      native.processIdentity(control.owner.process.pid)?.start === control.owner.process.start;
    const currentOwner =
      !this.poisoned &&
      this.lease?.token === control.owner.token &&
      control.owner.process.pid === process.pid;
    if (priorAlive && !currentOwner)
      recovery(
        `The prior host at ${control.owner.location} is still alive. Close it before recovery.`,
      );
    if (currentOwner) this.validate(request.lease, true);
    if (!existsSync(operationFile(this.rendezvous, control.pending.id)))
      recovery(
        'Pending external work has no typed execution receipt or verified child identity. Keep the store blocked for manual recovery; host death or elapsed time cannot clear it.',
      );
    const record = readOperation(this.rendezvous, control.pending.id);
    const lease: StoreLease = {
      token: control.owner.token,
      scopeId: control.owner.scopeId,
      storeId: registry.storeId,
      incarnation: registry.incarnation,
      fence: control.fence,
      revision: control.revision,
    };
    assertOperationOwner(record, lease);
    if (JSON.stringify(record.facts.scopes) !== JSON.stringify(control.pending.scopes))
      recovery('Operation and control scopes disagree.');
    if (
      control.pending.child &&
      (!record.child ||
        control.pending.child.pid !== record.child.pid ||
        control.pending.child.start !== record.child.start)
    )
      recovery('Control and operation process identities disagree.');
    if (
      record.child &&
      (native.processIdentity(record.child.pid)?.start === record.child.start ||
        !native.childGroupSettled(record.child.pid, record.id))
    )
      recovery(
        'The recorded Git process or its descendants may still run. Retry recovery only after they have stopped.',
      );
    this.database ??= openDatabase(join(registry.root, 'review.sqlite'), registry, control, true);
    if (accountScope(this.database, registry, this.actor) !== lease.scopeId)
      throw new StoreError(
        'WRONG_ACCOUNT',
        'Return to the original account or local owner scope before recovering this operation.',
      );
    const repository = this.repository(record.facts.worktree);
    repository.validateUpdate(record.ref, record.newOid);
    if (!repository.sameFacts(record.facts))
      recovery(
        'HEAD, index or worktree files changed. Preserve that work and reconcile it before recovery; no Git command was repeated.',
      );
    if (!repository.sameReferenceStorage(record, true))
      recovery(
        'Reference storage changed. Preserve its recovery records; no Git command was repeated.',
      );
    const actual = repository.refOid(record.ref);
    if (actual !== record.beforeOid && actual !== record.newOid)
      recovery(
        'The reference has an unexpected value. Preserve it for manual Git recovery; no command was repeated.',
      );
    if (
      record.phase === 'observed' &&
      ((record.outcome === 'applied' && actual !== record.newOid) ||
        (record.outcome === 'not-applied' && actual !== record.beforeOid))
    )
      recovery('The independent receipt and actual reference disagree.');
    this.poisoned = false;
    this.recoveryOwner = !currentOwner;
    this.control = control;
    this.lease = { ...lease, revision: metadata(this.database).revision };
    // A single unacknowledged projection commit can be ahead of control.
    // Lower/otherwise different revisions were already refused by openDatabase.
    if (this.lease.revision !== control.revision)
      this.saveControl({ ...control, revision: this.lease.revision });
    const outcome =
      record.phase === 'observed'
        ? record.outcome!
        : actual === record.newOid
          ? 'applied'
          : 'not-applied';
    this.projectOperation({ ...record, phase: 'observed', outcome });
    const reply = this.mutate(request, { id: record.id, phase: 'observed', outcome });
    this.recoveryOwner = false;
    return reply;
  }

  async dispatch(message: unknown): Promise<StoreReply> {
    if (
      !object(message) ||
      message.protocol !== 1 ||
      !uuid(message.id) ||
      ![
        'open',
        'inspect',
        'release',
        'renew',
        'handoff',
        'recordIntent',
        'prepareRef',
        'executeOperation',
        'recover',
        'inspectOperation',
        'saveCandidate',
        'readCandidate',
      ].includes(String(message.action))
    )
      throw new StoreError('INVALID_REQUEST', 'Unsupported storage request.');
    const request = message as unknown as StoreRequest;
    let sameWorkspace = request.workspacePath === this.config.location;
    if (!sameWorkspace && typeof request.workspacePath === 'string') {
      try {
        const requested = statSync(request.workspacePath, { bigint: true });
        const configured = statSync(this.config.location, { bigint: true });
        sameWorkspace =
          requested.isDirectory() &&
          configured.isDirectory() &&
          requested.dev === configured.dev &&
          requested.ino > 0n &&
          requested.ino === configured.ino;
      } catch {
        /* changed/unavailable workspace */
      }
    }
    if (!sameWorkspace)
      throw new StoreError(
        'WORKSPACE_CHANGED',
        'The window repository changed. Reopen the store before using a prepared operation.',
      );
    try {
      if (request.action === 'inspect') return this.inspect();
      if (request.action === 'open') return this.open(request);
      if (this.terminal?.id === request.id) {
        if (this.terminal.digest !== requestDigest(request))
          throw new StoreError('REQUEST_COLLISION', 'A completed request ID was reused.');
        return this.terminal.reply;
      }
      if (request.action === 'recover') return this.recoverOperation(request);
      if (request.action === 'recordIntent') return this.recordIntent(request);
      if (request.action === 'saveCandidate') return this.saveCandidate(request);
      if (request.action === 'readCandidate') return this.readCandidate(request);
      if (request.action === 'prepareRef') return this.prepareReference(request);
      if (request.action === 'executeOperation') return await this.executeOperation(request);
      if (request.action === 'inspectOperation') {
        this.validate(request.lease, false);
        if (!uuid(request.operationId))
          throw new StoreError('INVALID_OPERATION', 'An operation ID is required.');
        const record = readOperation(this.rendezvous, request.operationId);
        if (
          record.scopeId !== this.lease!.scopeId ||
          record.storeId !== this.lease!.storeId ||
          record.incarnation !== this.lease!.incarnation
        )
          throw new StoreError(
            'OPERATION_UNAVAILABLE',
            'This owner scope cannot inspect that operation.',
          );
        const projected = this.database!.prepare(
          'SELECT record FROM operation_records WHERE operation_id=?',
        ).get(record.id)?.record;
        if (projected !== JSON.stringify(record))
          recovery(
            'The independent receipt and database projection disagree. Use recovery, not execution retry.',
          );
        return {
          ...this.owned(),
          operation: {
            id: record.id,
            phase: record.phase,
            ...(record.outcome ? { outcome: record.outcome } : {}),
            ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
          },
        };
      }
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
        ![
          'STALE_LEASE',
          'REVISION_CONFLICT',
          'REQUEST_COLLISION',
          'HANDOFF_PENDING',
          'INVALID_OPERATION',
          'OPERATION_UNAVAILABLE',
          'WRONG_ACCOUNT',
          'GIT_INSPECTION',
          'REPOSITORY_LIMIT',
          'REPOSITORY_CHANGED',
          'REGISTRATION_CHANGED',
          'WORKSPACE_CHANGED',
          'INVALID_CANDIDATE',
        ].includes(error.code)
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

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { StoreProcess, StoreHandoff } from '../application/private-store';
import { StoreError } from '../application/private-store';

export interface NativeStore {
  tryAcquire(path: string): { readonly created: boolean } | null;
  release(handle: object): boolean;
  assertHeld(handle: object): void;
  assertLocalDirectory(path: string): void;
  assertPrivateDirectory(path: string): void;
  ensurePrivateDirectory(path: string): boolean;
  publishRecord(path: string, text: string): void;
  processIdentity(pid: number): StoreProcess | null;
}

export interface StoreRegistry {
  protocol: 1;
  root: string;
  storeId: string;
  incarnation: string;
  localScopeId: string;
}

export interface OwnerRecord {
  token: string;
  windowId: string;
  location: string;
  process: StoreProcess;
  scopeId: string;
  heartbeat: number;
}

export interface StoreControl {
  protocol: 1;
  storeId: string;
  incarnation: string;
  fence: number;
  revision: number;
  phase: 'initializing' | 'claiming' | 'owned' | 'releasing' | 'released' | 'handoff';
  owner: OwnerRecord | null;
  handoff?: StoreHandoff;
  pending?: { id: string; scopeId: string; scopes: string[]; child: StoreProcess | null };
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function text(value: unknown, limit = 32768): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
  );
}
export function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
}
export function recovery(message: string): never {
  throw new StoreError(
    'RECOVERY_REQUIRED',
    `${message} Review writes remain disabled; preserve the store and recovery records.`,
  );
}

export function readRecord(path: string, optional = false): unknown {
  let metadata;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    recovery('A required recovery record is missing.');
  }
  if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > 65536n)
    recovery('A recovery record is not a bounded regular file.');
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(file, { bigint: true });
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size > 65536n)
      recovery('A recovery record changed while opening it.');
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    recovery('A recovery record is unreadable or malformed.');
  } finally {
    closeSync(file);
  }
}

function checkProtocol(value: unknown) {
  if (object(value) && typeof value.protocol === 'number' && value.protocol > 1) {
    throw new StoreError(
      'NEWER_PROTOCOL',
      'This store uses a newer ownership protocol. Update the extension; no files were replaced.',
    );
  }
  if (!object(value) || value.protocol !== 1)
    recovery('The ownership protocol record is malformed.');
  return value;
}

export function readRegistry(path: string, optional = false): StoreRegistry | undefined {
  const raw = readRecord(path, optional);
  if (raw === undefined) return undefined;
  const value = checkProtocol(raw);
  if (
    !text(value.root) ||
    !isAbsolute(value.root) ||
    !uuid(value.storeId) ||
    !uuid(value.incarnation) ||
    !uuid(value.localScopeId)
  )
    recovery('The canonical store registry is malformed.');
  return value as unknown as StoreRegistry;
}

export function readControl(path: string, registry: StoreRegistry): StoreControl {
  const value = checkProtocol(readRecord(path));
  if (
    value.storeId !== registry.storeId ||
    value.incarnation !== registry.incarnation ||
    !sequence(value.fence) ||
    !sequence(value.revision) ||
    !['initializing', 'claiming', 'owned', 'releasing', 'released', 'handoff'].includes(
      String(value.phase),
    )
  )
    recovery('Store and control identities disagree.');
  if (value.owner !== null) {
    const owner = value.owner;
    if (
      !object(owner) ||
      !uuid(owner.token) ||
      !text(owner.windowId, 128) ||
      !text(owner.location) ||
      !uuid(owner.scopeId) ||
      !sequence(owner.heartbeat) ||
      !object(owner.process) ||
      !sequence(owner.process.pid) ||
      owner.process.pid < 1 ||
      !text(owner.process.start, 128)
    )
      recovery('Owner process metadata is malformed.');
  }
  if (['released', 'handoff'].includes(String(value.phase)) !== (value.owner === null))
    recovery('Owner phase and metadata disagree.');
  if (value.phase === 'handoff') {
    const offer = value.handoff;
    if (
      !object(offer) ||
      !uuid(offer.token) ||
      !text(offer.targetWindowId, 128) ||
      offer.storeId !== registry.storeId ||
      offer.incarnation !== registry.incarnation ||
      offer.fence !== value.fence
    )
      recovery('The handoff record is malformed.');
  } else if (value.handoff !== undefined)
    recovery('A handoff is attached to an incompatible phase.');
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (
      !object(pending) ||
      !uuid(pending.id) ||
      !uuid(pending.scopeId) ||
      !Array.isArray(pending.scopes) ||
      pending.scopes.length !== 2 ||
      !pending.scopes.every((scope) => text(scope, 1024)) ||
      (pending.child !== null &&
        (!object(pending.child) ||
          !sequence(pending.child.pid) ||
          pending.child.pid < 1 ||
          !text(pending.child.start, 128))) ||
      value.phase !== 'owned' ||
      !object(value.owner) ||
      pending.scopeId !== value.owner.scopeId
    )
      recovery('Pending operation metadata is malformed.');
  }
  return value as unknown as StoreControl;
}

export function publish(native: NativeStore, directory: string, name: string, value: unknown) {
  native.publishRecord(join(directory, name), JSON.stringify(value));
}

import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface NativeGuard {
  tryAcquire(path: string): object | null;
  release(handle: object): boolean;
  assertLocalDirectory(path: string): void;
  processIdentity(pid: number): { pid: number; start: string } | null;
}

// Load native code only in the worker. No canonical rendezvous or private store
// is touched by this disposable capability probe.
const native = createRequire(__filename)(join(__dirname, 'native-guard.node')) as NativeGuard;
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crw-guard-probe-')));
let guard: object | null = null;
let successor: object | null = null;
try {
  native.assertLocalDirectory(directory);
  const path = join(directory, 'guard');
  guard = native.tryAcquire(path);
  if (!guard || native.tryAcquire(path) !== null) throw new Error('OS guard exclusion failed');
  const identity = native.processIdentity(process.pid);
  if (!identity || identity.pid !== process.pid || !identity.start)
    throw new Error('OS identity unavailable');
  if (!native.release(guard)) throw new Error('OS release unconfirmed');
  successor = native.tryAcquire(path);
  if (!successor || native.release(guard) || native.tryAcquire(path) !== null) {
    throw new Error('Stale release affected successor');
  }
  if (!native.release(successor)) throw new Error('OS release unconfirmed');
  parentPort?.postMessage({ ok: true, start: identity.start });
} finally {
  if (successor) native.release(successor);
  if (guard) native.release(guard);
  rmSync(directory, { recursive: true, force: true });
  parentPort?.close();
}

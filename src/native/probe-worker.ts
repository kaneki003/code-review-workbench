import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface NativeGuard {
  tryAcquire(path: string): object | null;
  release(handle: object): boolean;
  assertLocalDirectory(path: string): void;
  processIdentity(pid: number): { pid: number; start: string } | null;
  assertHeld(handle: object): void;
  ensurePrivateDirectory(path: string): boolean;
  publishRecord(path: string, text: string): void;
}

// Load native code only in the worker. No canonical rendezvous or private store
// is touched by this disposable capability probe.
const progress = (stage: string) => parentPort?.postMessage({ stage });
progress('loading');
const native = createRequire(__filename)(join(__dirname, 'native-guard.node')) as NativeGuard;
progress('directory');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crw-guard-probe-')));
let guard: object | null = null;
let successor: object | null = null;
let start: string | undefined;
try {
  native.assertLocalDirectory(directory);
  progress('locking');
  const path = join(directory, 'guard');
  guard = native.tryAcquire(path);
  if (!guard || native.tryAcquire(path) !== null) throw new Error('OS guard exclusion failed');
  native.assertHeld(guard);
  progress('publication');
  const recovery = join(directory, 'private');
  native.ensurePrivateDirectory(recovery);
  native.publishRecord(join(recovery, 'control.json'), '{"phase":"probe"}');
  native.publishRecord(join(recovery, 'control.json'), '{"phase":"complete"}');
  if (readFileSync(join(recovery, 'control.json'), 'utf8') !== '{"phase":"complete"}')
    throw new Error('Durable record publication failed');
  progress('identity');
  const identity = native.processIdentity(process.pid);
  if (!identity || identity.pid !== process.pid || !identity.start)
    throw new Error('OS identity unavailable');
  progress('release');
  if (!native.release(guard)) throw new Error('OS release unconfirmed');
  successor = native.tryAcquire(path);
  if (!successor || native.release(guard) || native.tryAcquire(path) !== null) {
    throw new Error('Stale release affected successor');
  }
  if (!native.release(successor)) throw new Error('OS release unconfirmed');
  start = identity.start;
} finally {
  if (successor) native.release(successor);
  if (guard) native.release(guard);
  if (start) progress('cleanup');
  rmSync(directory, { recursive: true, force: true });
}
// The host can terminate the worker as soon as it receives a result.
// Acknowledge only after the disposable guard and directory are cleaned up.
parentPort?.postMessage({ ok: true, start });
parentPort?.close();

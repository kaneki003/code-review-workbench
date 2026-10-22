import { Worker } from 'node:worker_threads';
import type { Capability } from '../protocol/readiness';

interface SqliteWorkerResult {
  ok: true;
  sqlite: string;
  node: string;
}

const WORKER_TIMEOUT_MS = 5_000;

export async function probeSqlite(workerPath: string): Promise<Capability> {
  const unavailableCheck: Capability = {
    id: 'sqlite',
    label: 'Packaged SQLite worker',
    status: 'blocked',
    detail:
      'The packaged SQLite worker could not complete within five seconds. Reinstall the VSIX or use the supported embedded runtime, then check again. No private store was opened.',
  };
  let worker: Worker;
  try {
    worker = new Worker(workerPath);
  } catch {
    return unavailableCheck;
  }
  try {
    return await new Promise<Capability>((resolve) => {
      const workerTimeout = setTimeout(() => finish(unavailableCheck), WORKER_TIMEOUT_MS);
      const finish = (capability: Capability) => {
        clearTimeout(workerTimeout);
        resolve(capability);
      };
      worker.once('message', (result: unknown) => {
        if (!isSqliteWorkerResult(result)) {
          finish(unavailableCheck);
          return;
        }
        finish({
          id: 'sqlite',
          label: 'Packaged SQLite worker',
          status: 'passed',
          detail: `SQLite ${result.sqlite}; worker Node ${result.node}. In-memory parameterized transaction and rollback passed. Disk durability, WAL and shared-store ownership remain unverified. No private store was opened.`,
        });
      });
      worker.once('error', () => finish(unavailableCheck));
      worker.once('exit', () => finish(unavailableCheck));
    });
  } finally {
    await worker.terminate();
  }
}

function isSqliteWorkerResult(value: unknown): value is SqliteWorkerResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    'ok' in value &&
    value.ok === true &&
    'sqlite' in value &&
    typeof value.sqlite === 'string' &&
    'node' in value &&
    typeof value.node === 'string'
  );
}

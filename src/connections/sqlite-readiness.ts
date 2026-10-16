import { Worker } from 'node:worker_threads';
import type { Capability } from '../shared/readiness';

export async function probeSqlite(workerPath: string): Promise<Capability> {
  const blocked: Capability = {
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
    return blocked;
  }
  try {
    return await new Promise<Capability>((resolve) => {
      const timer = setTimeout(() => resolve(blocked), 5000);
      const finish = (capability: Capability) => {
        clearTimeout(timer);
        resolve(capability);
      };
      worker.once('message', (value: unknown) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('ok' in value) ||
          value.ok !== true ||
          !('sqlite' in value) ||
          typeof value.sqlite !== 'string' ||
          !('node' in value) ||
          typeof value.node !== 'string'
        )
          return finish(blocked);
        finish({
          id: 'sqlite',
          label: 'Packaged SQLite worker',
          status: 'passed',
          detail: `SQLite ${value.sqlite}; worker Node ${value.node}. In-memory parameterized transaction and rollback passed. Disk durability, WAL and shared-store ownership remain unverified. No private store was opened.`,
        });
      });
      worker.once('error', () => finish(blocked));
      worker.once('exit', () => finish(blocked));
    });
  } finally {
    await worker.terminate();
  }
}

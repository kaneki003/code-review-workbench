import { Worker } from 'node:worker_threads';
import type { Capability } from '../shared/readiness';

export async function probeNativeGuard(workerPath: string): Promise<Capability> {
  const blocked: Capability = {
    id: 'guard',
    label: 'Packaged ownership helper',
    status: 'blocked',
    detail:
      'The ownership helper could not run. Install the VSIX built for this OS and CPU on a supported local filesystem, then check again. Review writes remain disabled.',
  };
  let worker: Worker;
  try {
    worker = new Worker(workerPath);
  } catch {
    return blocked;
  }
  try {
    return await new Promise<Capability>((resolve) => {
      const timeout = setTimeout(() => finish(blocked), 5000);
      const finish = (check: Capability) => {
        clearTimeout(timeout);
        resolve(check);
      };
      worker.once('message', (message: unknown) => {
        if (
          typeof message !== 'object' ||
          message === null ||
          !('ok' in message) ||
          message.ok !== true ||
          !('start' in message) ||
          typeof message.start !== 'string' ||
          message.start.length === 0 ||
          message.start.length > 128
        ) {
          finish(blocked);
          return;
        }
        finish({
          id: 'guard',
          label: 'Packaged ownership helper',
          status: 'passed',
          detail:
            'Native helper loaded in the worker. OS lock, exclusion, release and process-start lookup passed in a disposable local folder. Durable recovery and shared-store ownership remain unverified.',
        });
      });
      worker.once('error', () => finish(blocked));
      worker.once('exit', () => finish(blocked));
    });
  } finally {
    await worker.terminate();
  }
}

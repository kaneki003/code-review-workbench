import { Worker } from 'node:worker_threads';
import type { Capability } from '../shared/readiness';

export async function probeNativeGuard(workerPath: string): Promise<Capability> {
  let stage = 'startup';
  const blocked = (reason: string): Capability => ({
    id: 'guard',
    label: 'Packaged ownership helper',
    status: 'blocked',
    detail: `The ownership helper could not run (${reason}; stage: ${stage}). ${stage === 'cleanup' ? 'Temporary-file cleanup did not finish. Check again.' : 'Install the VSIX built for this OS and CPU on a supported local filesystem, then check again.'} Review writes remain disabled.`,
  });
  let worker: Worker;
  try {
    worker = new Worker(workerPath);
  } catch {
    return blocked('worker startup failed');
  }
  try {
    return await new Promise<Capability>((resolve) => {
      let timeout = setTimeout(() => finish(blocked('probe timed out after five seconds')), 5000);
      let cleaningUp = false;
      let settled = false;
      const finish = (check: Capability) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(check);
      };
      worker.on('message', (message: unknown) => {
        if (settled) return;
        if (
          typeof message === 'object' &&
          message !== null &&
          'stage' in message &&
          typeof message.stage === 'string' &&
          /^[a-z-]{1,32}$/.test(message.stage)
        ) {
          stage = message.stage;
          if (stage === 'cleanup' && !cleaningUp) {
            // Every OS check and guard release has succeeded. Give disposable
            // file removal its own bounded window, once; success still waits
            // for the worker's acknowledgment after cleanup (at most 10 s total).
            cleaningUp = true;
            clearTimeout(timeout);
            timeout = setTimeout(
              () => finish(blocked('cleanup timed out after five seconds')),
              5000,
            );
          }
          return;
        }
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
          finish(blocked('invalid worker result'));
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
      worker.once('error', (error: Error & { code?: unknown }) => {
        const code =
          typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? `: ${error.code}`
            : '';
        finish(blocked(`worker error${code}`));
      });
      worker.once('exit', (code) => finish(blocked(`worker exited: ${code}`)));
    });
  } finally {
    await worker.terminate();
  }
}

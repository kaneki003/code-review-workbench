import { Worker } from 'node:worker_threads';
import type {
  StoreConfiguration,
  StoreConnection,
  StoreReply,
  StoreRequest,
} from '../application/private-store';
import { StoreError } from '../application/private-store';
import type { StorageDiagnostics } from './storage-diagnostics';
import { isCheckoutAction } from '../application/checkout-review';

// Configuration is host-owned. Never accept OS-home/root overrides from a
// webview, repository, VS Code setting or process HOME/USERPROFILE variable.
export function createStoreConnection(
  workerPath: string,
  configuration: StoreConfiguration,
  diagnostics?: StorageDiagnostics,
): StoreConnection {
  let worker: Worker | undefined;
  let failed = false;
  const pending = new Map<
    string,
    {
      resolve: (reply: StoreReply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function fail() {
    failed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new StoreError(
          'CONNECTION_UNKNOWN',
          'The storage worker stopped. Ownership may still need recovery; close this window and check again.',
        ),
      );
    }
    pending.clear();
  }
  function connect() {
    if (failed)
      throw new StoreError('CONNECTION_UNKNOWN', 'The storage connection needs a window restart.');
    if (worker) return worker;
    worker = new Worker(workerPath, {
      workerData: { ...configuration, ...(diagnostics ? { storageDiagnostics: diagnostics } : {}) },
    });
    worker.on('message', (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('id' in message) ||
        typeof message.id !== 'string'
      ) {
        fail();
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (
        'error' in message &&
        message.error &&
        typeof message.error === 'object' &&
        'code' in message.error &&
        typeof message.error.code === 'string' &&
        'message' in message.error &&
        typeof message.error.message === 'string'
      ) {
        item.reject(new StoreError(message.error.code, message.error.message));
      } else if (
        'reply' in message &&
        message.reply &&
        typeof message.reply === 'object' &&
        'view' in message.reply
      ) {
        item.resolve(message.reply as StoreReply);
      } else {
        item.reject(
          new StoreError(
            'PROTOCOL_UNKNOWN',
            'The storage worker returned an unsupported response.',
          ),
        );
        fail();
      }
    });
    worker.on('error', (error) => { console.error('[DEBUG-crw22-worker-error]', error); fail(); });
    worker.on('exit', (code) => { if(code !== 1) console.error('[DEBUG-crw22-worker-exit]', code); fail(); });
    return worker;
  }
  return {
    request(message: StoreRequest) {
      return new Promise((resolve, reject) => {
        const active = connect();
        if (pending.has(message.id)) {
          reject(new StoreError('REQUEST_IN_FLIGHT', 'This request is already in flight.'));
          return;
        }
        const timer = setTimeout(
          () => {
            pending.delete(message.id);
            failed = true;
            reject(
              new StoreError(
                'COMMIT_UNKNOWN',
                'The worker did not acknowledge the request. No save or release is confirmed; close this window and check ownership again.',
              ),
            );
            fail();
          },
          message.action === 'executeOperation'
            ? 60_000
            : message.action === 'publishSource' ||
                message.action === 'prepareCleanCheckout' ||
                isCheckoutAction(message.action)
              ? 45_000
              : 10_000,
        );
        pending.set(message.id, { resolve, reject, timer });
        try {
          active.postMessage(message);
        } catch {
          fail();
        }
      });
    },
    async dispose() {
      fail();
      if (worker) await worker.terminate();
    },
  };
}

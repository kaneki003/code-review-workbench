import { createRoot } from 'react-dom/client';
import { ReadinessView } from './readiness-view';
import {
  isReadinessResponse,
  type ReadinessReport,
  type ReadinessRequest,
} from '../shared/readiness';

declare function acquireVsCodeApi(): { postMessage(message: ReadinessRequest): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
const instanceId = root.dataset.instance!;
let initial = true;

function check(): Promise<ReadinessReport> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('Host did not respond. Check again.'));
    }, 12000);
    function receive(event: MessageEvent<unknown>) {
      if (
        !isReadinessResponse(event.data) ||
        event.data.instanceId !== instanceId ||
        event.data.requestId !== requestId
      )
        return;
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      resolve(event.data.report);
    }
    window.addEventListener('message', receive);
    vscode.postMessage({
      version: 1,
      type: initial ? 'ready' : 'recheck',
      instanceId,
      requestId,
      renderer: navigator.userAgent,
    });
    initial = false;
  });
}
createRoot(root).render(<ReadinessView check={check} />);

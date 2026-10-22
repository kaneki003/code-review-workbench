import { createRoot } from 'react-dom/client';
import { ReadinessView } from './readiness-view';
import {
  isReadinessResponse,
  type ReadinessReport,
  type ReadinessRequest,
} from '../../protocol/readiness';

declare function acquireVsCodeApi(): { postMessage(message: ReadinessRequest): void };

const HOST_RESPONSE_TIMEOUT_MS = 12_000;
const vscode = acquireVsCodeApi();
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('The readiness screen is missing its root element.');
}

const viewInstanceId = readViewInstanceId(rootElement);
let isFirstRequest = true;

function requestReadinessCheck(): Promise<ReadinessReport> {
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const responseTimeout = setTimeout(() => {
      window.removeEventListener('message', handleHostResponse);
      reject(new Error('Host did not respond. Check again.'));
    }, HOST_RESPONSE_TIMEOUT_MS);

    function handleHostResponse(event: MessageEvent<unknown>) {
      if (!isReadinessResponse(event.data)) {
        return;
      }

      const response = event.data;
      const isForThisView = response.instanceId === viewInstanceId;
      const isForThisRequest = response.requestId === requestId;
      if (!isForThisView || !isForThisRequest) {
        return;
      }

      clearTimeout(responseTimeout);
      window.removeEventListener('message', handleHostResponse);
      resolve(response.report);
    }

    window.addEventListener('message', handleHostResponse);
    vscode.postMessage({
      version: 1,
      type: isFirstRequest ? 'ready' : 'recheck',
      instanceId: viewInstanceId,
      requestId,
      renderer: navigator.userAgent,
    });
    isFirstRequest = false;
  });
}

createRoot(rootElement).render(<ReadinessView check={requestReadinessCheck} />);

function readViewInstanceId(element: HTMLElement): string {
  const instanceId = element.dataset.instance;
  if (!instanceId) {
    throw new Error('The readiness screen is missing its view identity.');
  }
  return instanceId;
}

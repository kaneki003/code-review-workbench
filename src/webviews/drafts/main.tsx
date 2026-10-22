import { createRoot } from 'react-dom/client';
import { DraftWriterClient } from './client';
import { DraftWriterView } from './writer-view';
import type { DraftRequest } from '../../protocol/drafts';

declare function acquireVsCodeApi(): { postMessage(message: DraftRequest): void };
const root = document.getElementById('root');
if (!root?.dataset.instance) throw new Error('The draft writer has no view identity.');
const vscode = acquireVsCodeApi();
const client = new DraftWriterClient(root.dataset.instance, (message) =>
  vscode.postMessage(message),
);
window.addEventListener('message', (event: MessageEvent<unknown>) => client.receive(event.data));
window.addEventListener('pagehide', () => client.dispose());
createRoot(root).render(<DraftWriterView client={client} />);

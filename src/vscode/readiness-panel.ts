import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { isReadinessRequest, type ReadinessReport } from '../shared/readiness';

export function createReadinessPanel(extensionUri: vscode.Uri, check: () => Promise<ReadinessReport>) {
  let panel: vscode.WebviewPanel | undefined;
  let last: ReadinessReport | undefined;
  let running: Promise<ReadinessReport> | undefined;
  function run() {
    if (!running) running = check().then(report => { last = report; return report; }).finally(() => { running = undefined; });
    return running;
  }
  return {
    async show() {
      // This read-only screen has no input to retain. Recreate on command so a
      // repeated invocation gets a fresh projection and webview attachment.
      panel?.dispose();
      {
        let renderer = '';
        const project = (report: ReadinessReport): ReadinessReport => ({ ...report, checks: [...report.checks,
          { id: 'renderer', label: 'Packaged webview', status: 'passed', detail: renderer }] });
        let attached: () => void;
        let timer: ReturnType<typeof setTimeout>;
        const loaded = new Promise<void>((resolve, reject) => {
          attached = resolve;
          timer = setTimeout(() => reject(new Error('Packaged readiness screen did not load. Reinstall the VSIX and try again.')), 12000);
        });
        const resources = vscode.Uri.joinPath(extensionUri, 'dist');
        const current = vscode.window.createWebviewPanel('codeReviewWorkbench.readiness', 'Workbench readiness', vscode.ViewColumn.Beside,
          { enableScripts: true, localResourceRoots: [resources] });
        panel = current;
        const instanceId = randomUUID();
        const nonce = randomUUID();
        const script = current.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'readiness.js'));
        const css = current.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'readiness.css'));
        const listener = current.webview.onDidReceiveMessage(async (message: unknown) => {
          if (!isReadinessRequest(message) || message.instanceId !== instanceId) return;
          // Renderer metadata is display evidence only; it never authorizes work.
          renderer = message.renderer;
          const report = message.type === 'ready' ? last ?? await run() : await run();
          if (panel === current) await current.webview.postMessage({ version: 1, type: 'readinessResult', instanceId,
            requestId: message.requestId, report: project(report) });
          if (message.type === 'ready') attached();
        });
        current.onDidDispose(() => { listener.dispose(); if (panel === current) { panel = undefined; last = undefined; } });
        current.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${current.webview.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none'">
          <link rel="stylesheet" href="${css}"><title>Workbench readiness</title></head>
          <body><div id="root" data-instance="${instanceId}"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
        try {
          const [report] = await Promise.all([run(), loaded]);
          return project(report);
        } finally { clearTimeout(timer!); }
      }
    },
    dispose() { panel?.dispose(); },
  };
}

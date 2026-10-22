import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  isReadinessRequest,
  type ReadinessReport,
  type ReadinessResponse,
} from '../../protocol/readiness';

const PANEL_LOAD_TIMEOUT_MS = 12_000;

export function createReadinessPanel(
  extensionUri: vscode.Uri,
  checkReadiness: () => Promise<ReadinessReport>,
) {
  let activePanel: vscode.WebviewPanel | undefined;

  return {
    async show(): Promise<ReadinessReport | undefined> {
      // Reopening has no unsaved input to preserve. Give the new screen its own
      // results so a check from a closed screen cannot replace its report.
      activePanel?.dispose();

      const resourceDirectory = vscode.Uri.joinPath(extensionUri, 'dist');
      const openedPanel = vscode.window.createWebviewPanel(
        'codeReviewWorkbench.readiness',
        'Workbench readiness',
        vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [resourceDirectory] },
      );
      activePanel = openedPanel;
      const viewInstanceId = randomUUID();

      let latestReport: ReadinessReport | undefined;
      let pendingCheck: Promise<ReadinessReport> | undefined;
      let rendererDescription = '';

      function runReadinessCheck(): Promise<ReadinessReport> {
        // The command and the screen's initial message can arrive together.
        // They should share one check rather than start two sets of probes.
        if (!pendingCheck) {
          pendingCheck = checkReadiness()
            .then((report) => {
              latestReport = report;
              return report;
            })
            .finally(() => {
              pendingCheck = undefined;
            });
        }
        return pendingCheck;
      }

      function includeRendererDetails(report: ReadinessReport): ReadinessReport {
        return {
          ...report,
          checks: [
            ...report.checks,
            {
              id: 'renderer',
              label: 'Packaged webview',
              status: 'passed',
              detail: rendererDescription,
            },
          ],
        };
      }

      let finishLoading: (didLoad: boolean) => void;
      let loadTimeout: ReturnType<typeof setTimeout> | undefined;
      const panelDidLoad = new Promise<boolean>((resolve, reject) => {
        finishLoading = resolve;
        loadTimeout = setTimeout(() => {
          reject(
            new Error('Packaged readiness screen did not load. Reinstall the VSIX and try again.'),
          );
        }, PANEL_LOAD_TIMEOUT_MS);
      });

      const messageSubscription = openedPanel.webview.onDidReceiveMessage(
        async (message: unknown) => {
          if (!isReadinessRequest(message)) {
            return;
          }
          if (message.instanceId !== viewInstanceId || activePanel !== openedPanel) {
            return;
          }

          // This comes from the browser and is display evidence, not authorization.
          rendererDescription = message.renderer;

          let report: ReadinessReport;
          if (message.type === 'ready' && latestReport) {
            report = latestReport;
          } else {
            report = await runReadinessCheck();
          }

          // The user may have closed this panel while its probes were running.
          if (activePanel !== openedPanel) {
            return;
          }

          const response: ReadinessResponse = {
            version: 1,
            type: 'readinessResult',
            instanceId: viewInstanceId,
            requestId: message.requestId,
            report: includeRendererDetails(report),
          };
          await openedPanel.webview.postMessage(response);

          if (message.type === 'ready') {
            finishLoading(true);
          }
        },
      );

      openedPanel.onDidDispose(() => {
        messageSubscription.dispose();
        // Closing is cancellation; it must not later become a false load failure.
        finishLoading(false);
        clearTimeout(loadTimeout);

        if (activePanel === openedPanel) {
          activePanel = undefined;
        }
      });

      openedPanel.webview.html = createReadinessHtml(
        openedPanel.webview,
        resourceDirectory,
        viewInstanceId,
      );

      try {
        const [report, didLoad] = await Promise.all([runReadinessCheck(), panelDidLoad]);
        if (!didLoad || activePanel !== openedPanel) {
          return undefined;
        }
        return includeRendererDetails(report);
      } finally {
        clearTimeout(loadTimeout);
      }
    },

    dispose() {
      activePanel?.dispose();
    },
  };
}

function createReadinessHtml(
  webview: vscode.Webview,
  resourceDirectory: vscode.Uri,
  viewInstanceId: string,
): string {
  const scriptNonce = randomUUID();
  const stylesheetUri = webview.asWebviewUri(
    vscode.Uri.joinPath(resourceDirectory, 'readiness.css'),
  );
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(resourceDirectory, 'readiness.js'));
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}'`,
    `style-src ${webview.cspSource}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
    <link rel="stylesheet" href="${stylesheetUri}">
    <title>Workbench readiness</title>
  </head>
  <body>
    <div id="root" data-instance="${viewInstanceId}"></div>
    <script nonce="${scriptNonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

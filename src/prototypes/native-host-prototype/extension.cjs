// THROWAWAY HOST EXPERIMENT. No network, credentials, subprocesses or Git operations.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

const anchor = Object.freeze({ revision: '7e93a1', path: 'src/workers/worker.ts', start: 76, end: 81, thread: 'companion-concurrency' });
const current = vscode.Uri.parse('crw-prototype:/7e93a1/src/workers/worker.ts');
const original = vscode.Uri.parse('crw-prototype:/6dcb810/src/workers/worker.ts');
const evidence = vscode.Uri.parse('crw-prototype:/7e93a1/src/storage/export_store.ts');
const range = new vscode.Range(75, 0, 80, 40);

function worker(old) {
  const lines = ['// FICTIONAL source · ' + (old ? '6dcb810 (original)' : '7e93a1 (inspected)'), 'export async function exportRows(rows, uploadPart) {'];
  while (lines.length < 73) lines.push('  // export pipeline step ' + (lines.length + 1));
  lines.push('  const pending = [];', '  for await (const row of rows) {', '    const chunk = encodeCsv(row);', old ? '    await uploadPart(chunk);' : '    pending.push(uploadPart(chunk));', '  }', old ? '  // Uploads complete before next row.' : '  await Promise.all(pending);', '  return { complete: true };', '}');
  while (lines.length < 100) lines.push('// Fixture context ' + (lines.length + 1));
  return lines.join('\n');
}

exports.activate = async context => {
  await fs.mkdir(context.globalStorageUri.fsPath, {recursive: true});
  const draftFile = path.join(context.globalStorageUri.fsPath, 'PROTOTYPE-draft.json');
  const auditFile = path.join(context.globalStorageUri.fsPath, 'PROTOTYPE-audit.jsonl');
  const log = (event, detail = {}) => fs.appendFile(auditFile, JSON.stringify({at:new Date().toISOString(), event, ...detail}) + '\n');
  await log('activation', {vscode: vscode.version, platform: process.platform, arch: process.arch, versions:process.versions});
  let draft = {anchor, text:'', revision:0};
  try { draft = JSON.parse(await fs.readFile(draftFile, 'utf8')); } catch {}
  await log('restored', {revision:draft.revision, characters:draft.text.length, anchor:draft.anchor});
  let writes = Promise.resolve();
  let failSaves = false;
  let writer;
  let writerClosed = false;
  let writerRender = 0;
  const persist = text => {
    const operation = writes.then(async () => {
      if (failSaves) throw new Error('Simulated disk failure; last acknowledged text remains on disk');
      const next = {anchor, text, revision:draft.revision + 1};
      await fs.writeFile(draftFile + '.tmp', JSON.stringify(next, null, 2));
      await fs.rename(draftFile + '.tmp', draftFile);
      draft = next;
      await log('saved', {revision:draft.revision, characters:text.length, anchor});
      return next;
    });
    writes = operation.catch(() => {});
    return operation;
  };
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand('crwSpike.' + name, fn));
  const source = async (uri = current, selection = range) => {
    const editor = await vscode.window.showTextDocument(uri, {preview:false, selection, viewColumn:vscode.ViewColumn.One});
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    await log('sourceFocus', {uri:uri.toString(), line:selection.start.line + 1});
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('crw-prototype', {
    provideTextDocumentContent: uri => uri.path.includes('export_store')
      ? '// FICTIONAL evidence · 7e93a1\nexport function createUpload(upload) {\n  // This helper does not impose a concurrency bound.\n  return chunk => upload(chunk);\n}\n'
      : worker(uri.path.includes('6dcb810'))
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => log('documentChange', {scheme:e.document.uri.scheme, changes:e.contentChanges.length})));

  const collaborators = vscode.comments.createCommentController('crw-prototype.collaborators', 'GitHub collaborators · FICTIONAL');
  const companion = vscode.comments.createCommentController('crw-prototype.companion', 'Companion · FICTIONAL');
  context.subscriptions.push(collaborators, companion);
  const comment = (name, text) => ({author:{name}, body:new vscode.MarkdownString(text), mode:vscode.CommentMode.Preview});
  const collaborator = collaborators.createCommentThread(current, range, [comment('Maya · collaborator (fixture)', 'What bounds the number of multipart uploads?\n\n**Published GitHub thread · simulated** · Source 7e93a1, lines 76–81.')]);
  collaborator.label = 'GitHub collaborators · 7e93a1:76–81';
  collaborator.canReply = true;
  collaborator.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  const suggestion = companion.createCommentThread(current, range, [comment('Companion (fixture)', '**Performance · Major**\n\n**Observation:** Each row adds an upload promise before awaiting all results.\n\n**Hypothesis:** Large exports may start unbounded uploads.\n\n**Source:** 7e93a1 · worker.ts:76–81. Use the evidence command to inspect the helper.\n\n**Limit:** No workload has been executed.\n\nUse **CRW Prototype: Open anchored local draft** to try the separate writer.')]);
  suggestion.label = 'Companion · Performance · Major · 7e93a1';
  suggestion.canReply = false;
  suggestion.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  const oldThread = collaborators.createCommentThread(original, new vscode.Range(75, 0, 78, 20), [comment('Maya · earlier source (fixture)', '**Original source · 6dcb810:76–79.** This stays on the original URI and is never relabelled current.')]);
  oldThread.canReply = false;
  oldThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  const fileThread = companion.createCommentThread(current, new vscode.Range(0,0,0,0), [comment('Companion · file note (fixture)', '**File-level note · 7e93a1**. This record has no line range.')]);
  fileThread.range = undefined;
  fileThread.canReply = false;
  fileThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  await log('threadsCreated', {sameLine:2, originalUri:original.toString(), fileRange:fileThread.range ?? null, invalid:'not attached; navigation explains original target'});

  const items = [
    ['worker.ts · native diff · 7e93a1', 'open'],
    ['Related source · export_store.ts · 7e93a1', 'evidence'],
    ['Back to worker.ts · original concern', 'return'],
    ['Local draft · worker.ts:76–81 · 7e93a1', 'writer'],
    ['Unavailable anchor · removed.ts:400 · 01dead0', 'invalid'],
    ['Original source · 6dcb810:76–79', 'original'],
    ['Probe: recreate writer DOM', 'recreate'],
    ['Probe: toggle failing saves', 'failSave'],
    ['Probe: cycle dark / light / high contrast', 'theme']
  ];
  context.subscriptions.push(vscode.window.registerTreeDataProvider('crwSpike.files', {
    getChildren: () => items,
    getTreeItem: ([label, command]) => ({label, collapsibleState:vscode.TreeItemCollapsibleState.None, command:{command:'crwSpike.'+command, title:label}})
  }));

  const baseStyle = `body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:10px;line-height:1.5}h2{font-size:15px;margin:0 0 8px}p{margin:8px 0}button,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-contrastBorder,transparent));padding:6px}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer;white-space:normal}button:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}small{color:var(--vscode-descriptionForeground)}.target{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}textarea{box-sizing:border-box;width:100%;min-height:100px;resize:vertical}.error{color:var(--vscode-errorForeground)}`;
  const html = (body, script = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-prototype'; script-src 'nonce-prototype';"><style nonce="prototype">${baseStyle}</style></head><body>${body}<script nonce="prototype">${script}</script></body></html>`;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('crwSpike.companion', {
    resolveWebviewView: view => {
      view.webview.options = {enableScripts:true};
      view.webview.html = html(`<h2>Companion · fixture</h2><div class="row"><button id="context" aria-pressed="true">Context</button><button id="chat" aria-pressed="false">Chat</button></div><div id="content"><p class="target">PR 248 / Worker &amp; output / worker.ts</p><p><b>File context</b></p><p>Inspect multipart upload concurrency at 7e93a1. Draft writing is being compared in a separate bottom panel.</p><p><b>Checkpoint context</b></p><p>Stream rows, upload CSV and recover safely.</p><p><b>PR context</b></p><p>Fictional background CSV exports.</p></div><small>PROTOTYPE · no AI or GitHub connection.</small>`, `const initial=document.getElementById('content').innerHTML;for(const id of ['context','chat'])document.getElementById(id).onclick=()=>{document.getElementById('content').innerHTML=id==='context'?initial:'<p>Private Chat fixture. No AI is connected.</p>';for(const key of ['context','chat'])document.getElementById(key).setAttribute('aria-pressed',String(id===key));};`);
      view.onDidChangeVisibility(() => log('companionVisibility', {visible:view.visible}));
    }
  }));
  const renderWriter = () => {
    if (!writer) return;
    writer.webview.html = html(`<!-- render ${++writerRender} --><h2>Local draft · separate bottom-panel alternative</h2><p class="target"><b>worker.ts:76–81 · 7e93a1</b> · Companion concurrency concern</p><small>Unsent · saved only in the disposable profile. This placement changes the approved inline writer.</small><section id="writing"><label for="draft">Feedback text</label><textarea id="draft" aria-describedby="status"></textarea><div class="row"><button id="close">Close · retain draft</button><button id="retry">Retry save</button><button id="source">Return to source</button><span id="status" role="status" aria-live="polite">Loading retained text…</span></div></section><section id="closed" hidden><p>Draft retained at worker.ts:76–81 · 7e93a1.</p><button id="reopen">Reopen draft</button></section><details><summary>Prototype state</summary><pre id="state"></pre></details>`, `const api=acquireVsCodeApi();const report=()=>api.postMessage({type:'surface',width:innerWidth,height:innerHeight,theme:document.body.className,overflow:document.documentElement.scrollWidth>innerWidth});window.addEventListener('resize',report);new MutationObserver(report).observe(document.body,{attributes:true,attributeFilter:['class']});report();document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();document.getElementById('close').click();}});const input=document.getElementById('draft'),status=document.getElementById('status');let sequence=0;let acknowledged=0;let loaded=false;const send=()=>{sequence++;api.setState({text:input.value,sequence});status.textContent='Saving…';api.postMessage({type:'edit',text:input.value,sequence});};input.addEventListener('input',send);document.getElementById('retry').onclick=send;document.getElementById('close').onclick=()=>{api.postMessage({type:'close',text:input.value,sequence:++sequence});};document.getElementById('reopen').onclick=()=>api.postMessage({type:'ready',reopen:true});document.getElementById('source').onclick=()=>api.postMessage({type:'source'});window.addEventListener('message',({data:m})=>{if(m.type==='restore'){if(!loaded){input.value=m.draft.text;loaded=true;}document.getElementById('writing').hidden=m.closed;document.getElementById('closed').hidden=!m.closed;status.textContent='Saved on this device · revision '+m.draft.revision;if(!m.closed)input.focus();}if(m.type==='ack'){acknowledged=m.sequence;if(m.sequence===sequence)status.textContent='Saved on this device · revision '+m.draft.revision;status.className='';api.setState({text:input.value,sequence,acknowledged});}if(m.type==='closed'){document.getElementById('writing').hidden=true;document.getElementById('closed').hidden=false;}if(m.type==='error'){status.textContent='Could not save · Retry';status.className='error';}document.getElementById('state').textContent=JSON.stringify(m,null,2);});api.postMessage({type:'ready'});`);
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('crwSpike.draft', {
    resolveWebviewView: view => {
      writer = view;
      view.webview.options = {enableScripts:true};
      view.webview.onDidReceiveMessage(async message => {
        if (message.type === 'surface') { await log('writerSurface', message); return; }
        try {
          if (message.type === 'ready') {
            await writes;
            if (message.reopen) writerClosed = false;
            await view.webview.postMessage({type:'restore', draft, closed:writerClosed});
            await log('writerReady', {revision:draft.revision, characters:draft.text.length, closed:writerClosed});
          }
          if (message.type === 'edit' || message.type === 'close') {
            const saved = await persist(message.text);
            await view.webview.postMessage({type:'ack', sequence:message.sequence, draft:saved});
            if (message.type === 'close') {
              writerClosed = true;
              await view.webview.postMessage({type:'closed'});
              await source();
              await log('writerClosed', {revision:draft.revision});
            }
          }
          if (message.type === 'source') await source();
        } catch (error) {
          await view.webview.postMessage({type:'error', message:error.message});
          await log('saveFailed', {message:error.message});
        }
      });
      view.onDidChangeVisibility(() => log('writerVisibility', {visible:view.visible}));
      view.onDidDispose(() => { if (writer === view) writer = undefined; log('writerDisposed'); });
      renderWriter();
    }
  }));
  register('open', async () => {
    await vscode.commands.executeCommand('vscode.diff', original, current, 'worker.ts · 6dcb810 ↔ 7e93a1 · PROTOTYPE', {preview:false});
    for (const editor of vscode.window.visibleTextEditors) if (editor.document.uri.toString() === current.toString()) {editor.selection = new vscode.Selection(range.start, range.end);editor.revealRange(range, vscode.TextEditorRevealType.InCenter);}
    await vscode.commands.executeCommand('crwSpike.files.focus');
    await vscode.commands.executeCommand('crwSpike.companion.focus');
    await log('diffOpened');
  });
  register('writer', async () => {writerClosed = false;await vscode.commands.executeCommand('crwSpike.draft.focus');if(writer)renderWriter();});
  register('evidence', () => source(evidence, new vscode.Range(1,0,3,0)));
  register('return', () => source());
  register('original', () => source(original, new vscode.Range(75,0,78,20)));
  let themeIndex = 0;
  register('theme', async () => {
    const theme = ['Default Dark Modern', 'Default Light Modern', 'Default High Contrast'][++themeIndex % 3];
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
    await log('themeRequested', {theme});
  });
  register('invalid', async () => {
    const doc = await vscode.workspace.openTextDocument({language:'markdown', content:'# Unavailable original anchor\n\nremoved.ts:400 · revision 01dead0 · fixture thread missing-source\n\nThe original source is unavailable. No current line has been invented. The comment and original target remain accessible here.\n\nUse CRW Prototype: Return to worker source to resume.\n'});
    await vscode.window.showTextDocument(doc, {preview:false});
    await log('invalidAnchorShown', {revision:'01dead0', path:'removed.ts', line:400, reanchored:false});
  });
  register('capture', async reply => {await log('nativeExplicitCapture', {characters:reply.text.length});await persist(reply.text);vscode.window.showInformationMessage('Explicit local capture only. No automatic native-input save was observed.');});
  register('recreate', async () => {await writes;renderWriter();await log('writerDomRecreated');});
  register('failSave', async () => {failSaves=!failSaves;await log('saveFailureToggle',{failSaves});vscode.window.showInformationMessage('Prototype save failure: '+failSaves);});
  register('audit', () => vscode.window.showTextDocument(vscode.Uri.file(auditFile), {preview:false}));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.text = '$(comment-discussion) PROTOTYPE · Local draft';
  status.command = 'crwSpike.writer';
  status.show();
  context.subscriptions.push(status);
  await log('ready', {draftFile, auditFile, publicOnly:true});
};

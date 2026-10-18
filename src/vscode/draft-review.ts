import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ReviewManager } from '../application/review-manager';
import type { LocalDraft, DraftWriterProjection } from '../application/local-draft';
import type { CommittedSource } from '../application/committed-source';
import { draftSnapshotChunks, type DraftSnapshot } from '../shared/draft-writer';
import { committedDocumentUri } from './committed-links';
import type { createCommittedReview } from './committed-review';

export function createDraftReview(
  context: vscode.ExtensionContext,
  committed: ReturnType<typeof createCommittedReview>,
  initialManager: ReviewManager,
) {
  let manager = initialManager;
  let source: CommittedSource | undefined;
  let view: vscode.WebviewView | undefined;
  let bound:
    | { view: vscode.WebviewView; owner: ReviewManager; instanceId: string; ready: boolean }
    | undefined;
  let sending = false;
  let pendingProjection:
    { destination: NonNullable<typeof bound>; snapshot: DraftSnapshot } | undefined;
  let refreshGeneration = 0;
  const drafts = new Map<string, LocalDraft>();
  const threads = new Map<string, vscode.CommentThread>();
  const sources = new Map<string, CommittedSource>();
  const controller = vscode.comments.createCommentController(
    'codeReviewWorkbench.localDrafts',
    'Private local drafts',
  );
  const lastDraftKey = `localDraft/${vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? ''}`;
  let unsubscribe = manager.onDraftWriterChange(changed);
  const subscriptions: vscode.Disposable[] = [controller];

  function send(snapshot: DraftSnapshot) {
    const destination = bound;
    if (!destination || destination.instanceId !== snapshot.instanceId) return;
    pendingProjection = { destination, snapshot };
    void drain();
  }
  async function drain() {
    if (sending) return;
    sending = true;
    try {
      while (pendingProjection) {
        const { destination, snapshot } = pendingProjection;
        pendingProjection = undefined;
        if (bound !== destination) continue;
        for (const chunk of draftSnapshotChunks(snapshot)) {
          // Keep at most one newer complete projection waiting. Incomplete old
          // transfers are harmless; the receiver resynchronizes from a full one.
          if (
            bound !== destination ||
            pendingProjection ||
            !(await destination.view.webview.postMessage(chunk))
          )
            break;
        }
      }
    } catch {
      /* Presentation may disappear; host-owned saves continue. */
    } finally {
      sending = false;
      if (pendingProjection) void drain();
    }
  }
  function changed() {
    if (bound) send(manager.snapshotDraftWriter(bound.instanceId));
    const pending = manager.readDraftWriter();
    if (pending) {
      drafts.set(pending.id, pending);
      void updateThread(pending).catch(showError);
    } else if (source) void refresh().catch(showError);
  }
  async function updateThread(draft: LocalDraft | DraftWriterProjection) {
    const generation = refreshGeneration;
    let snapshot = sources.get(draft.target.anchor.sourceId);
    if (!snapshot) {
      const loaded = await manager.readCommittedSource(draft.target.anchor.sourceId);
      if (generation !== refreshGeneration || loaded.status !== 'ready') return;
      snapshot = loaded.source;
      sources.set(snapshot.id, snapshot);
    }
    const file = snapshot.files.find((item) => item.id === draft.target.anchor.fileId);
    if (!file) return;
    const anchor = draft.target.anchor;
    let thread = threads.get(draft.id);
    if (!thread) {
      thread = controller.createCommentThread(
        vscode.Uri.parse(committedDocumentUri(snapshot, file, anchor.side)),
        new vscode.Range(
          anchor.range.startLine,
          anchor.range.startCharacter,
          anchor.range.endLine,
          anchor.range.endCharacter,
        ),
        [],
      );
      thread.canReply = false;
      thread.contextValue = 'crw-local-draft';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      threads.set(draft.id, thread);
    }
    const status = 'status' in draft ? draft.status : 'saved';
    const label =
      status === 'saved'
        ? 'Saved on this device'
        : status === 'failed'
          ? 'Failed to save · Reopen to Retry'
          : status === 'discarding'
            ? 'Discarding local draft…'
            : 'Saving on this device…';
    thread.label = `Local draft · ${anchor.side === 'old' ? 'Original' : 'New'} · ${anchor.commit.slice(0, 8)}`;
    const preview =
      draft.body.length > 8000
        ? `${draft.body.slice(0, 8000).replace(/[\uD800-\uDBFF]$/, '')}\n\n_Preview shortened. Open the local draft for its complete text._`
        : draft.body;
    const body = new vscode.MarkdownString(preview || '_Empty local draft_');
    body.isTrusted = false;
    body.supportHtml = false;
    thread.comments = [
      {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: 'You · Local draft' },
        label,
        contextValue: 'crw-local-draft',
      },
    ];
  }
  async function refresh() {
    const selected = source;
    const generation = ++refreshGeneration;
    if (!selected) return;
    const records = await manager.listReviewDrafts(selected.id);
    if (generation !== refreshGeneration) return;
    drafts.clear();
    for (const draft of records) drafts.set(draft.id, draft);
    const pending = manager.readDraftWriter();
    if (pending && drafts.has(pending.id)) drafts.set(pending.id, pending);
    for (const [id, thread] of threads)
      if (!drafts.has(id)) {
        thread.dispose();
        threads.delete(id);
      }
    await Promise.all([...drafts.values()].map(updateThread));
  }
  function bindView(opened: vscode.WebviewView) {
    if (bound) bound.owner.detachDraftWriter(bound.instanceId);
    const instanceId = randomUUID();
    bound = { view: opened, owner: manager, instanceId, ready: false };
    manager.attachDraftWriter(instanceId);
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    opened.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const nonce = randomUUID();
    const script = opened.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'draft-writer.js'));
    const css = opened.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'readiness.css'));
    opened.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${opened.webview.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${css}"><title>Private local draft</title></head><body><div id="root" data-instance="${instanceId}"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(opened) {
      view = opened;
      bindView(opened);
      const messages = opened.webview.onDidReceiveMessage(async (message: unknown) => {
        const destination = bound;
        if (!destination || destination.view !== opened) return;
        const result = await destination.owner.handleDraftWriterMessage(message);
        if (bound !== destination) return;
        if (
          result.accepted &&
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'ready'
        )
          destination.ready = true;
        if (result.snapshot) send(result.snapshot);
        if (result.closedTarget && !result.duplicate) {
          await refresh().catch(showError);
          await committed.returnToSource(result.closedTarget).catch(showError);
        } else if (
          result.accepted &&
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'discard'
        ) {
          await refresh().catch(showError);
        }
      });
      const visibility = opened.onDidChangeVisibility(() => {
        if (opened.visible && !bound) bindView(opened);
        else if (!opened.visible && bound?.view === opened) {
          bound.owner.detachDraftWriter(bound.instanceId);
          bound = undefined;
        }
      });
      opened.onDidDispose(() => {
        messages.dispose();
        visibility.dispose();
        if (bound?.view === opened) {
          bound.owner.detachDraftWriter(bound.instanceId);
          bound = undefined;
        }
        if (view === opened) view = undefined;
      });
    },
  };
  subscriptions.push(
    vscode.window.registerWebviewViewProvider('codeReviewWorkbench.writer', provider),
  );

  async function show() {
    await vscode.commands.executeCommand('codeReviewWorkbench.writer.focus');
    view?.show(false);
    const deadline = Date.now() + 12_000;
    while (!view?.visible || !bound?.ready) {
      if (Date.now() > deadline)
        throw new Error(
          'The private writer did not become ready. Its host-owned input is retained; recreate the writer and Retry.',
        );
      // Native Comments can auto-open while its first thread is added. A
      // reveal inside the hide event can lose to that same transition. Wait
      // for the next host turn and finish the explicit writer-open action.
      if (!view?.visible) {
        await vscode.commands.executeCommand('codeReviewWorkbench.writer.focus');
        view?.show(false);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    view.show(false);
  }
  function showError(error: unknown) {
    void vscode.window.showWarningMessage(
      error instanceof Error ? error.message : 'The original local draft is unavailable.',
    );
  }
  async function open(input?: unknown) {
    let id =
      typeof input === 'string' ? input : [...threads].find(([, thread]) => thread === input)?.[0];
    if (!id) {
      // Listing records must not republish native threads here: VS Code's
      // automatic Comments-view activation can otherwise dismiss the picker.
      const known = source ? await manager.listReviewDrafts(source.id) : [];
      if (!known.length) {
        const last = context.workspaceState.get<string>(lastDraftKey);
        if (last && (await manager.readLocalDraft(last))) id = last;
        else
          throw new Error(
            'No saved local draft is available in this verified review. Select a committed source range to write one.',
          );
      } else
        id = (
          await vscode.window.showQuickPick(
            known.map((draft) => ({
              label: `${draft.target.anchor.path}:${draft.target.anchor.range.startLine + 1}`,
              description: `Local draft · ${draft.target.anchor.side === 'old' ? 'Original' : 'New'} · ${draft.target.anchor.commit.slice(0, 8)}`,
              detail: draft.body.slice(0, 160) || 'Empty local draft',
              id: draft.id,
            })),
            {
              title: 'Private local drafts · original source targets',
              ignoreFocusOut: true,
              matchOnDescription: true,
              matchOnDetail: true,
            },
          )
        )?.id;
    }
    if (!id) return;
    const draft = await manager.readLocalDraft(id);
    if (!draft || draft.deletionRevision)
      throw new Error('This local draft is unavailable or was discarded.');
    await manager.openDraftWriter(id);
    const thread = threads.get(id);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await committed.returnToSource(draft.target).catch(showError);
    await context.workspaceState.update(lastDraftKey, id);
    await show();
    return draft;
  }
  async function write() {
    if (!(await prepareChange())) return;
    const target = await committed.captureDraftTarget();
    const draft = await manager.createLocalDraft(target);
    await manager.openDraftWriter(draft.id);
    await context.workspaceState.update(lastDraftKey, draft.id);
    drafts.set(draft.id, draft);
    await updateThread(draft);
    const thread = threads.get(draft.id);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await show();
    return draft;
  }
  async function prepareChange() {
    const pending = manager.readDraftWriter();
    return !pending || Boolean(await manager.closeDraftWriter(pending.writerId));
  }
  for (const [name, action] of [
    ['writeLocalDraft', write],
    ['openLocalDraft', open],
    ['showLocalDrafts', () => open()],
    [
      'recreateDraftWriter',
      async () => {
        if (view) bindView(view);
        await show();
      },
    ],
  ] as const)
    subscriptions.push(
      vscode.commands.registerCommand(`codeReviewWorkbench.${name}`, async (input?: unknown) => {
        try {
          return await action(input);
        } catch (error) {
          showError(error);
          return undefined;
        }
      }),
    );
  function clear() {
    refreshGeneration += 1;
    source = undefined;
    drafts.clear();
    sources.clear();
    for (const thread of threads.values()) thread.dispose();
    threads.clear();
  }
  return {
    prepareChange,
    clear,
    async showSource(selected: CommittedSource, owner = manager) {
      if (owner !== manager) {
        if (!(await prepareChange()))
          throw new Error('Save the current draft before selecting another owner.');
        if (bound) bound.owner.detachDraftWriter(bound.instanceId);
        unsubscribe();
        clear();
        manager = owner;
        unsubscribe = manager.onDraftWriterChange(changed);
        if (view?.visible) bindView(view);
      }
      source = selected;
      sources.set(selected.id, selected);
      await refresh();
    },
    dispose() {
      if (bound) bound.owner.detachDraftWriter(bound.instanceId);
      bound = undefined;
      pendingProjection = undefined;
      unsubscribe();
      clear();
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

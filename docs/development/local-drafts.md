# Anchored local drafts

[Save and reopen anchored local drafts (#21)](https://github.com/kaneki003/code-review-workbench/issues/21) adds private feedback at an exact committed source range. The movable bottom writer saves through the host manager and SQLite worker. Native source threads and **Show Local Drafts** reopen the same record at its original target.

## Walk through the changes

1. **Capture the original source.** [Committed review](../../src/vscode/committed-review.ts) captures the selected comparison, file, original/new side, path, blob, commit, range and focus-return information. [Public manager actions](../../src/application/review-manager.ts) copy inputs before queueing. The worker resolves the target through existing exact-source validation. Absent or different source is rejected. Drafting does not change source, refs or the working tree.

2. **Retain a private identity.** [Draft values](../../src/application/local-draft.ts) define an opaque draft identity, account/immutable-PR review identity, content generation and revisions. The target never follows later file navigation or a newer source generation. Discovery includes earlier retained source generations in the same original local copy. Another account or copy cannot inherit their text. Content generation starts at 1; full private-data clearing belongs to its later workflow.

3. **Commit a precise edit.** [Draft persistence](../../src/connections/local-draft-storage.ts) uses the existing `requests` journal, schema and ownership protocol. The creation row holds one authoritative current snapshot, addressed by its primary key, beside an immutable body-free creation receipt. Each save updates only that snapshot and inserts one body-free receipt. [Worker coordination](../../src/connections/store-worker.ts) commits text, immutable target, revisions and receipt in one transaction: those changes succeed or fail together. Per-edit write work does not grow with the draft's save history. Discovery searches creation rows outside the typing path.

4. **Own pending input in the host.** [DraftWriter](../../src/application/draft-writer.ts) belongs to the manager independently of the browser. It saves about 300 ms after idle and schedules a save by one second of continuous pending typing. A newer edit arriving during an in-flight save stays pending. Older receipts advance durable revisions without replacing text or marking newer input Saved. Close flushes all received edits and returns the original target only after the newest acknowledgment. Failed Close retains the writer. Release and changing reviews also wait for a flush. Switching drafts flushes edits received while the next record was being read; failure retains the old writer.

5. **Fence and assemble view requests.** [The shared protocol](../../src/shared/draft-writer.ts) defines finite version-1 messages; [the protocol manager](../../src/application/draft-writer-protocol.ts) validates view/request/writer/draft identity, store incarnation, ownership fence, content generation and expected revisions. An incarnation identifies this store; a fence distinguishes successive owners. Reused requests cannot repeat an effect. Text uses 44 KiB raw chunks so complete JSON envelopes stay within 64 KiB. A complete, valid UTF-8 payload must arrive before applying an edit. The limit is 1 MiB UTF-8. Output is chunked too, with at most one newer projection waiting behind a send. Gaps request a complete reset. Fencing suppresses stale presentation while preserving body-free receipts for actual committed mutations.

6. **Keep visible input honest.** [The React client](../../src/webviews/draft-client.ts) retains newer browser input while acknowledgments arrive. [The composer](../../src/webviews/draft-writer-view.tsx) shows the original PR/file/side/range/commit, Write/Preview, formatting, save status, Close and Discard. React's `useSyncExternalStore` subscribes to the transport client's current state; it does not own storage. Failed or oversized input stays visible with Copy input and Retry. Preview disables raw HTML and remote images. Account fencing clears private presentation immediately. Rejected browser-only input remains in memory as a hidden recovery copy and becomes visible only after the host verifies that exact original draft/review/content identity. It is never written to browser or workspace storage.

7. **Separate native reading from view lifetime.** [Native integration](../../src/vscode/draft-review.ts) registers the bottom `WebviewView`, source threads and discovery. A `WebviewView` is a VS Code pane the user can move or hide; each renderer gets a fresh instance identity and current host state. Native tags offer **Open Local Draft** at the original source. Large native previews are explicitly shortened; the writer retains complete text. Hiding, moving or recreating the pane does not cancel host autosave. Only the last opaque draft id goes in workspace state. Host reload can reopen that known draft after its original account/store is verified; full automatic active-review resume is separate.

8. **Discard durably.** Discard waits for an existing save, clears the body and advances the deletion revision in one transaction. Delayed saves cannot resurrect that identity; new writing creates a fresh one. Failed Discard keeps input and Retry repeats deletion. Confirmed deletion also removes the native tag. A historical duplicate save can return its old body-free receipt but cannot restore text. Discard is separate from Close and future all-managed-copy private-data clearing.

## How to try it

Use the pinned Node/pnpm versions and a native build toolchain described in [shared ownership](shared-state-ownership.md#approved-packaging-change):

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

1. Install `dist/code-review-workbench.vsix` using **Extensions: Install from VSIX…**. Open a trusted, already-cloned repository with Git on PATH and VS Code 1.141.2 or newer.
2. Run **Code Review Workbench: Open Pull Request Overview**, select a GitHub.com PR and verify the original account. Run **Inspect Committed PR Diffs**.
3. Open a changed diff or **Open Exact-Revision Source**, select an eligible range on either committed side, and run **Write Private Local Draft** from the editor context menu or Command Palette. The **Private Feedback** panel shows that exact target.
4. Type multiline Unicode or unfinished Markdown. Expect Saving, then Saved on this device after the actual commit. Switch Write/Preview. Press Escape or Close: the newest input saves and focus returns to the original source selection.
5. Expand its native **Local draft** tag and choose **Open Local Draft**, or run **Show Local Drafts**. Expect the same text, identity and original target. Navigate to another file while writing; the displayed target stays fixed.
6. Hide the panel immediately after typing or move **Local Draft** to the sidebar using VS Code's **Move View** action. Reopen it: host-received pending input remains. After a host reload, verify the original overview/store and use **Open Local Draft** for its known saved record.
7. Use Discard draft. Expect removal only after deletion commits. Writing at the same range again creates a new record. Close alone keeps the saved draft.

At a short panel height the view scrolls; keyboard focus reveals footer controls. Drag the panel divider or maximize it to see the whole composer. The layout wraps in narrow views and uses VS Code semantic theme colors, with Inter/JetBrains Mono fallbacks. Tailwind utilities are compiled into the packaged CSS.

## Failures and recovery

Busy, read-only, full-disk or failed commits keep input and the original target visible. Keep a copy, resolve the storage problem, then Retry. Close/Escape do not leave a failed writer. Failed Discard retries deletion. Oversized input stays visible for copying or trimming; no truncated prefix is acknowledged. A transport timeout exposes the same recovery controls.

If the panel does not initialize, hide and reopen **Private Feedback**. The view reconnects to host-owned state automatically. The internal `codeReviewWorkbench.recreateDraftWriter` command only forces a fresh renderer for installed-host lifecycle tests; it is not listed in the Command Palette or panel toolbar and is not invoked for save recovery. It cannot recover browser-only input that never reached the host.

[Transaction primitives](../../src/connections/store-database.ts) classify a write as retryable only after confirmed rollback and verification that the authoritative store revision is unchanged. SQLite may automatically roll back after `SQLITE_FULL`; that path does not attempt a second rollback. Unknown outcomes, failed rollback or inconsistent metadata require storage recovery rather than blind retry.

Only text acknowledged Saved is assured after a killed host. Browser-only input can be lost with its renderer, and host-received but uncommitted input with the host. Drafting creates no GitHub pending record, publication or AI request.

## Verification and limits

[Manager tests](../../tests/committed-source.test.ts) use real repositories, ordered workers and SQLite through the agreed public interface. They cover exact targets, restart/reopen, account/copy isolation, retained generations, duplicate/colliding/stale revisions, deletion barriers, input limits, chunk assembly/reordering, autosave cadence and in-flight edits. A competing connection causes actual contention. Host-only diagnostics trigger real SQLite constraint, read-only and allocation failures; views, settings and environment variables cannot request those diagnostics.

[React tests](../../tests/draft-writer-view.test.tsx) connect typing and controls to the same manager/worker. [Installed-host checks](../../tests/host/draft-writer.ts) type through Chromium into the packaged VSIX, force failed commits, Retry, Preview, Close/Escape, reopen through native discovery, recreate/move/hide the pane and Discard. They inspect accessibility names, focus return, dark/light/high-contrast themes, zoom and narrow wrapping. The test runner alone enables a loopback browser-debug endpoint in its disposable profile. CI uploads runtime evidence and screenshots for each supported OS/version cell.

These checks establish accessibility names and keyboard/focus behavior, not a complete manual screen-reader reading session. The editable Figma file was unavailable here; checked-in hierarchy and written contracts guided styling, but exact parity needs owner comparison. Power-loss/device durability and full automatic review resume are not established. See the [review and validation record](local-drafts-review.md).

# Enter and exit a clean PR checkout

[Issue #22](https://github.com/kaneki003/code-review-workbench/issues/22) adds explicit clean PR checkout and Exit Review to the committed-source reader. Ordinary source/diff reading remains available without switching. Unfinished prior work and review-time edits require later preservation slices; this transition refuses them while retaining the work.

## Try the feature

Build/install the VSIX using the README, open one trusted, already-cloned local repository root and run:

1. **Code Review Workbench: Open Pull Request Overview**. Verify the intended local copy and original GitHub account.
2. **Code Review Workbench: Enter PR Checkout**. The command refreshes the verified PR metadata, fetches its exact source, saves through normal host behavior and checks the resulting repository. A clean supported state enters a fresh owned branch at the exact inspected PR head. The Changed Files view identifies the inspected commit.
3. Read native committed diffs or ordinary files. Closing tabs or hiding/moving a view leaves the review active. Saving/staging files does not update inspected committed source.
4. **Code Review Workbench: Exit Review**. With clean review files, this restores the original branch at its expected commit or exact detached HEAD, then restores and verifies the original editor arrangement. Completion follows the durable receipt.

If a normal save creates unfinished changes, entry is refused after saving them; commit/preserve the changes through ordinary Git before Retry. Cancelled, failed or unstable saves, untitled/unsupported tabs and uncertain buffers refuse switching. No stash, reset, clean or dependency installation is performed by this slice.

## Recover a transition

The affected repository receives a startup notice when it retains an interrupted checkout. An unrelated local project receives no checkout recovery choice or restoration authority.

Run **Recover PR Checkout**, verify the original PR/account when requested, then choose **Continue the saved transition** or **Restore my previous work**. The manager first settles/reconciles pending owned Git processes. A request to stop a process, a missing receipt or elapsed time never proves checkout stopped.

Recovery inspects the actual branch, commit, index/files and operation receipts. It can finish a completed checkout, continue a verified unperformed transition on a fresh branch, restore previous work, or retry only editor restoration after Git is already restored. It never blindly repeats an interrupted checkout. A moved/missing original branch, a manual commit, dirty files, another worktree's branch or uncertain process keeps specific blocked recovery and all necessary artifacts. Resolve the identified condition through ordinary Git/host behavior and Retry; no hard reset repairs it.

A failed editor restoration retains its snapshot and the restoring-editors phase. After reconnecting the original account, retry restoration without another checkout. Older source remains identified by its exact committed revision; this ticket does not add active Source Sync.

If someone manually returns an Active review to its original clean checkout, Continue keeps the recovery record and asks for explicit Restore before restoring editors. An interruption after completion but before artifact cleanup resumes cleanup through Recover or repeated Exit, without repeating Git or editor restoration.

## Walk through the implementation

1. **Manager actions.** [ReviewManager](../../src/application/review-manager.ts) serializes Enter, Exit and recovery independently of view lifetime. Host bindings in [extension.ts](../../src/extension.ts) register commands and repository-scoped notices. Presentation generations prevent stale command results from reopening views after a later action. View/menu state does not authorize Git.
2. **Native saves and editor capture.** [checkout-editors.ts](../../src/vscode/checkout-editors.ts) saves normally, inventories stable groups/tabs and records text/diff selections, selection direction, active sides, pinned/preview state and vertical source position. It restores the original layout and verifies observable host state before resolving. [overview-documents.ts](../../src/vscode/overview-documents.ts) rehydrates the workbench's own read-only Markdown/preview content from the authorized snapshot after owner recreation. Unsupported or ambiguous host representations stop the transition.
3. **Lifecycle journal.** [checkout-review.ts](../../src/application/checkout-review.ts) defines the serializable record. [checkout-journal.ts](../../src/connections/checkout-journal.ts) publishes independent recovery facts before a short SQLite transaction projects them. The snapshot is bounded by UTF-8 bytes. Row revisions remain distinct from ownership revisions; every write rechecks the live OS guard/fence inside its transaction. A database/independent disagreement enters reconciliation, rather than assuming an external effect completed. No database transaction spans Git, dialogs or editor restoration.
4. **Verified source and original protection.** [store-worker.ts](../../src/connections/store-worker.ts) binds the transition to the verified account, source generation and canonical local copy. It saves the original editor/Git facts before effects. A separately journaled guarded update pins the original exact commit at `refs/code-review-workbench/recovery/<entry ID>/original`. That Git reference keeps an otherwise-unreachable detached user commit alive through reflog expiry and garbage collection.
5. **Typed protected checkout.** [repository-operation.ts](../../src/connections/repository-operation.ts) creates a collision-checked `refs/heads/code-review-workbench/<entry ID>` branch at the exact PR head. The existing native process guard identifies a paused child before launching non-force `checkout --no-overwrite-ignore --no-recurse-submodules`. Hooks and lazy fetch are disabled. Revalidation protects repository identity, HEAD, index/files, reference/reflog paths and branch/worktree ownership before and after the effect. Raw file hashes independently verify clean content, so a misleading Git stat cache cannot authorize overwriting hidden edits.
6. **Active and Exit receipts.** Active follows agreement among exact source, actual checkout and durable receipts. Exit uses the original entry receipt, verifies the original destination and clean file/index-content fingerprint, and waits for host restoration before saving completion. The fingerprint excludes Git's disposable index stat cache. Interrupted phases retain enough independent and database evidence to reconcile actual outcomes.
7. **Conservative cleanup.** After completion, guarded compare-and-swap reference deletion can remove the proven-owned original pin and an unchanged, unused review branch whose commits are already reachable from the restored HEAD. Unmerged, moved, in-use or ambiguous artifacts remain reachable. Source-generation references needed by committed reading/anchors remain retained. Cleanup has the same durable process/receipt protocol as other effects.

## Supported representations and limits

The clean-only path supports existing branch and detached-HEAD entry, normal tracked files, exact byte representations and supported native text/diff/owned-overview tabs. Configured filters, transformed working-file representations, sparse/split index, special index flags, unresolved entries, submodules and unfinished Git operations receive a safe refusal. Ignored files remain in place; collisions refuse protected checkout. File/reference bounds remain the existing 10,000-file/128 MiB inspection limits.

Editor snapshots are bounded to nine groups, 100 tabs and 48,000 UTF-8 bytes. Custom/notebook/terminal-editor tabs, unknown previews, remote/untitled resources and ambiguous duplicate embedded diffs require closing or resolving that representation before switching. Ordinary terminal panels remain untouched. The public native API exposes vertical ranges and selections; rendered Markdown preview pixel scroll and horizontal pixel offsets are not claimed as exported native editor positions.

External manual writers do not honor the application's OS guard. Git's non-force checkout and expected-value ref updates protect effects, with before/after checks detecting observed interference. Unexpected state blocks further automatic repair and preserves user work/recovery facts.

## Verification

The primary fixtures drive public manager actions with real disposable Git, localhost transport, the production SQLite worker and native process guard. They cover exact entry/restoration, detached reachability, ignored collisions, redirected/shared metadata, hidden stat-cache edits, dirty work, worktree ownership, unrelated projects, save cancellation, failed host restoration, bounded Unicode snapshots and interrupted intent/checkout/Active/restoration/completion.

The packaged-host fixture exercises actual normal saves, refusal of resulting unfinished changes, native text/diff/overview tabs, pinned tabs, multiple/reversed selections, vertical position, owner/worker recreation and verified Exit. Focused system-boundary adapters inject save/host failures; they do not replace the actual-host proof path.

```sh
pnpm check
pnpm exec vitest run tests/committed-source.test.ts
pnpm validate
pnpm test:host
CRW_VSCODE_VERSION=1.141.2 pnpm test:host
```

See the [review record](clean-checkout-review.md) and PR checks for final findings and platform evidence.

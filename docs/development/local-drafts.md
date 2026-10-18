# Anchored local drafts: durable core checkpoint

This is the first implementation checkpoint for [Save and reopen anchored local drafts (#21)](https://github.com/kaneki003/code-review-workbench/issues/21). It implements the public review-manager actions and durable SQLite records. The bottom writer is still pending. No new user command is exposed at this checkpoint.

The owner requested a working checkpoint and walkthrough when the change became substantial. Review this layer before continuing with the React writer and native integration. This checkpoint does not complete #21.

## Walk through the changes

1. **Capture a committed target.** `ReviewManager.createLocalDraft` receives a source navigation target: comparison, file, original/new side, path, blob, commit, range and focus return information. The worker resolves it through the same exact-source validation used for navigation. A missing, absent or different source is rejected. The action copies its input before queueing, so later changes to the caller's object cannot change the requested target.

2. **Create one private record.** The worker assigns an opaque draft identity. Drafts of the same account and immutable PR identity share an opaque review identity and a content generation. Original targets remain fixed. New source generations can have new drafts while older drafts retain their original objects and ranges. The current generation starts at 1; advancing it for full private-data clearing belongs to that later workflow.

3. **Acknowledge a specific edit.** `saveLocalDraft` carries a request identity, draft/review/content identities, expected row and committed revisions, a newer edit revision and the complete text. The worker checks those values, then commits text, target, revisions and the receipt together. An edit revision identifies the input being committed; a row revision counts durable changes to the draft record. Coalesced input may skip edit numbers. The returned receipt contains revisions and identity, with no replacement body.

4. **Keep writes ordered and retries precise.** The manager and worker retain their existing ordered queues and ownership checks. The worker rechecks the store incarnation, ownership fence and global revision inside each transaction. Duplicate request identities return the earlier receipt without another effect. The global lease revision is excluded from a draft request's content digest because unrelated commits advance it; owner token, account scope, store identity and fence remain part of that digest. A reused request identity with different content is rejected.

5. **Discard one identity.** `discardLocalDraft` checks the expected version, clears its body and advances its deletion revision in one transaction. New delayed saves against that identity are refused. A duplicate earlier save can return its historical receipt, but cannot restore the body. New writing receives a new draft identity. The host writer must also ignore historical acknowledgments after it closes or discards; that view protocol is the next layer.

6. **Recover or retry from real storage state.** `readLocalDraft` and `listLocalDrafts` load account-scoped records independently of views. A confirmed failed transaction leaves the prior body and revisions intact. Busy, read-only, full-disk and constraint failures become retryable only after rollback and verification that the authoritative store revision is unchanged. SQLite can roll back automatically after `SQLITE_FULL`; that case does not attempt a second rollback. An unknown failure, failed rollback or inconsistent metadata still requires storage recovery.

## Storage and reading order

This slice uses the existing durable `requests` journal and its ownership/schema protocol. The creation row holds the authoritative current draft snapshot beside its body-free creation receipt. Its primary key is the draft identity. Each save/discard updates that one snapshot and adds a body-free mutation receipt in the same transaction. Reads and edits use primary-key lookup; per-edit write work does not grow with the draft's save history. Discovery searches creation records, outside the typing path. Discard leaves a content-free tombstone in the current snapshot. This avoids introducing an unversioned table or a separate migration/backup workflow in this ticket. It does not perform the later all-managed-copy private-data clearing operation.

Read the code in this order:

1. [Draft values and limits](../../src/application/local-draft.ts): immutable targets, expected versions and body-free acknowledgments.
2. [Public manager actions](../../src/application/review-manager.ts): copied inputs, ordered dispatch and account/session fencing.
3. [Worker coordination](../../src/connections/store-worker.ts): exact target resolution, mutation checks, transaction and acknowledgment.
4. [Draft persistence](../../src/connections/local-draft-storage.ts): scoped lookup, current-body retention and version checks.
5. [Transaction and receipt primitives](../../src/connections/store-database.ts): confirmed rollback and duplicate request handling.
6. [Public action tests](../../tests/committed-source.test.ts): real repositories, workers and SQLite writes, driven through the manager.

## Verify this checkpoint

Use the repository's pinned Node and pnpm versions:

```sh
pnpm check
pnpm exec vitest run tests/committed-source.test.ts
pnpm validate
```

The draft cases cover restart/reopen, exact original/new targets, stale and duplicate saves, version conflicts, discard versus delayed saves, account isolation, newer committed source, captured queued input and the 1 MiB UTF-8 ceiling. Text includes Unicode, a leading Unicode BOM, NUL and unfinished Markdown. Oversized and ill-formed replacements leave the acknowledged body intact.

Failure cases use actual SQLite failures. A second connection holds a write transaction for contention; host-only diagnostics trigger a constraint failure, SQLite read-only mode or bounded allocation that produces `SQLITE_FULL`. These controls are not accepted from views, repository settings or environment variables. Tests recover through the same public actions and assert the saved records, rather than inspect private SQL state.

These are local macOS arm64 behavioral checks. They do not establish installed-host writer behavior, another operating system, power-loss durability or visual/accessibility parity.

At `4cfd9f8`, `pnpm validate` passed formatting, type checking and all 153 tests across nine files. The source/draft file passed all 25 cases. The environment was macOS arm64, Node 24.22.0 and Git 2.56.0. See the [two-axis checkpoint review](local-drafts-review.md) for its finding and resolution.

## Remaining work in #21

- Host-owned live pending input and the 300 ms idle / one-second scheduling deadline, including an edit arriving during an in-flight save.
- Finite versioned view messages, view/request tokens, projection sequence recovery and complete 64 KiB transport-chunk assembly.
- The accepted bottom React writer, its original-target display, truthful Saving/Saved/Failed state, visible input/copy recovery, Retry and Close/Escape behavior.
- Native draft tags/discovery, source focus return, view hiding/moving/disposal/recreation and known-draft reopening after host reload.
- React interaction and installed-host typing, Close/Retry/Discard, keyboard, screen-reader, theme, zoom and narrow-layout checks.

Drafting exposes no GitHub mutation, AI request or source-edit action. The source fixtures establish exact committed inputs before drafting. Draft target validation reads those objects; draft actions do not fetch, change refs or modify source.

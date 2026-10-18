# Clean-checkout implementation checkpoint

Issue [Enter and exit a clean PR checkout (#22)](https://github.com/kaneki003/code-review-workbench/issues/22) is **in progress**. This checkpoint adds the guarded Git transition layer. It does not expose Enter PR Checkout or Exit Review commands, declare an Active checkout, or acknowledge restored editor state. Continue using the existing no-switch committed-source reader.

## Walk through the foundation

1. `ReviewManager.prepareCleanCheckout(sourceId)` selects a previously verified, downloaded PR source. The store checks the actual local copy, a clean index/worktree and supported Git state. It records the original branch and exact commit (or detached HEAD), a restoration fingerprint, and a collision-checked new `refs/heads/code-review-workbench/<operation ID>` branch. A separately journaled guarded reference update pins the original commit at `refs/code-review-workbench/recovery/<entry operation ID>/original` before checkout can be prepared. Both entry and restoration verify that protection.
2. The existing operation journal saves independent intent, the ownership barrier and the SQLite projection before Git can run. The operation includes expected-before repository facts, target branch/commit and protected reference paths. Checkout additionally protects HEAD and its reflog from redirects/shared file links.
3. `executeRepositoryOperation(operationId)` revalidates the live owner, repository facts and branch/worktree ownership before dispatching a paused, identified Git child. It uses non-force `checkout --no-overwrite-ignore --no-recurse-submodules`, with hooks and lazy fetch disabled. Configured filters and unsupported index/reference representations refuse switching. Preflight verifies tracked file bytes and executable/type information against index blobs independently of Git's stat cache. Working-file transformations that differ from the indexed representation stay in no-switch reading at this checkpoint; validation does not execute filters to normalize them.
4. The launcher verifies child/process-group settlement. It compares actual checkout facts with the intended target or unchanged original state before recording an outcome. An unexpected state remains recovery work; it cannot become a successful receipt.
5. `prepareCleanRestore(entryOperationId)` reads the verified original entry receipt. It refuses review-time edits, commits, moved/missing original branches and another worktree's branch. A successful restoration must match the original branch/exact commit and saved file/index-content fingerprint. The fingerprint excludes Git's disposable index stat cache, which naturally changes across a checkout.
6. Interrupted operations use the existing explicit store recovery. Recovery waits for the prior owner and Git descendants to stop, inspects actual state and records the observed result. It does not repeat checkout. The entry receipt survives owner-generation changes, so a new owner can prepare a verified restoration, including an original detached HEAD.

The runtime reading order is [review manager](../../src/application/review-manager.ts), [store dispatch and operation projection](../../src/connections/store-worker.ts), then [Git validation and typed child preparation](../../src/connections/repository-operation.ts). Behavior fixtures live in [committed-source tests](../../tests/committed-source.test.ts) and the [disposable host process](../../tests/fixtures/source-process.ts).

All branches and source references are retained at this checkpoint. No cleanup, reset, clean, dependency installation, push or stash operation is added.

## Evidence and limits

The public-interface fixtures use real disposable Git repositories, localhost Git transport, the production SQLite worker and native process guard. They exercise exact-PR checkout/restoration, a killed host after checkout dispatch, restoration of detached HEAD, ignored-path collisions, shared HEAD reflogs, split index, unfinished prior/review edits, original branch movement and user commits on the owned branch. Regression fixtures also hide edits from Git's stat cache and expire reflogs/prune unreachable objects while an original detached commit remains protected.

These checks establish the Git foundation only. They do not establish native editor restoration or Windows/Linux checkout support. Run the focused checks with:

```sh
pnpm check
pnpm exec vitest run tests/committed-source.test.ts
```

Local checkpoint validation passed formatting, TypeScript checking and all **150 tests in nine files** on macOS arm64, Node 24.22.0 and Git 2.56.0. The checkout fixtures explicitly disable line-ending conversion so they test exact byte representations consistently. The [automated review record](clean-checkout-review.md) records findings and fixes.

## Remaining issue #22 work

- Capture, save, re-inventory and durably retain actual native editor groups, tabs, selections and positions before checkout; handle cancelled, failed and unstable saves.
- Add the review lifecycle journal, Enter/Exit/recovery commands and projections. Commit Active only after checkout/source agreement; commit Exit complete only after Git and host restoration agree.
- Reconcile interrupted entry, interrupted restoration, source-state commit and failed host restoration. Offer repository-scoped continue/restore choices, with accurate blockers and no blind replay.
- Clean only proven-owned unused refs/branches after durable completion; retain user commits and ambiguous artifacts.
- Complete fault-boundary, cancellation, worktree-ownership and installed-host fixtures. Run the minimum/current VS Code matrix on Windows x64, Linux x64 and macOS arm64 before claiming support.

The draft PR is a review checkpoint, not completion of #22 or permission to merge.

# Preserve prior work during PR review

Implementation for [issue #23](https://github.com/kaneki003/code-review-workbench/issues/23), awaiting owner review in [draft PR #36](https://github.com/kaneki003/code-review-workbench/pull/36). [ADR 0006](../adr/0006-use-ordinary-git-for-review-checkouts.md) governs the ordinary Git flow and manual recovery. Cross-platform acceptance remains open.

## Walk through the change

1. [ReviewManager](../../src/application/review-manager.ts) serializes checkout actions in its window. [checkout-documents.ts](../../src/vscode/documents/checkout.ts) asks VS Code to save documents. Cancelled or failed saving prevents Git entry. The manager resolves the retained committed source before passing its exact head to Git.
2. [checkout-git.ts](../../src/git/checkout.ts) creates `.git/code-review-workbench/checkout.json` exclusively. This bounded receipt records the window, source, original branch/commit, target, stash marker/object and current step. An existing receipt blocks another entry in the same checkout. Different repositories have independent receipts.
3. When Git reports changes, Enter runs `git stash push --include-untracked`, records the resulting stash object, then runs `git switch --detach <target>`. Git handles attributes, filters and index/worktree representations. There is no parallel file manifest or attribute verifier.
4. Exit switches to the recorded branch or detached commit, applies the exact stash with `git stash apply --index`, then finds and drops its matching stash-list entry after successful application. Completion removes the receipt. VS Code owns editor tabs, layout, selections and scroll state.
5. A failed command stops the transition. The result and receipt retain its command, exit code and Git output. **Recover PR Checkout** displays the receipt. After completing recovery through ordinary Git, choose **I completed Git recovery** to clear it. Clearing runs no Git command. Interrupted commands are never automatically replayed, repaired or rolled back.

The obsolete checkout journal, byte manifests, editor snapshots and guarded checkout/stash operations have been deleted. Source/draft storage still uses the older global ownership implementation pending the separate SQLite coordination migration under [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md). This checkpoint does not establish concurrent storage access across windows.

## How to try it

```sh
pnpm validate
pnpm test:host
```

[checkout-git.test.ts](../../tests/git/checkout.test.ts) uses disposable real repositories to exercise staged/unstaged/new-file restoration, detached HEAD, same-checkout exclusion, independent repositories, command diagnostics and stash conflicts. Manager tests in [committed-source.test.ts](../../tests/application/checkout.test.ts) check save cancellation and source-to-checkout routing. The installed-host fixture in [readiness.ts](../../tests/host/main.ts) exercises normal VS Code saving and verifies the restored branch, index and file contents after manager recreation.

For a manual check, use a disposable clone. Stage an edit, add another edit to that file, and create an untracked file. Open a verified PR overview and run **Enter PR Checkout**. Expect the exact PR commit in detached HEAD and a named stash. Run **Exit Review**. Expect the original branch, staged version, later disk edit and new file, with the matching stash removed.

To inspect failure handling, create a conflicting review-time edit before Exit. Expect the Git failure diagnostics and a retained stash and receipt. Recover with ordinary Git, then acknowledge completion through **Recover PR Checkout**. The extension does not preserve review-time edits in a separate stash in this ticket.

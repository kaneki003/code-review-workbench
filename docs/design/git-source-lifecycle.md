# Git and source lifecycle

Status: amended 21 October 2026 by [ADR 0006](../adr/0006-use-ordinary-git-for-review-checkouts.md) and [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md). These decisions supersede verified byte manifests, owned recovery refs, automatic Git reconciliation and editor-state restoration.

## Authority and scope

Git is authoritative for commits, refs, HEAD, the index, the worktree and stashes. The workbench stores only the identities needed to request a transition and explain an interruption. It does not independently decide whether Git faithfully represented a path, mode, attribute, filter, sparse index, symlink or submodule state.

The review source is an exact committed head object. Staged, unstaged, untracked and unsaved changes are never review input. No-switch committed-source reading remains available when the user does not want to change the checkout.

One review may be active per working checkout/window. Different repositories in different windows may be reviewed concurrently. A repository-local receipt excludes a second transition only in the same checkout.

## Repository-local receipt

Before the first Git mutation, atomically create a small versioned receipt under the checkout's Git directory. It contains:

- canonical working repository and Git-directory paths;
- window and committed-source identities;
- original branch, or `null` for detached HEAD, plus exact original commit;
- exact target commit;
- unique stash marker and stash object when one was created;
- current step; and
- the last failed command, exit code, stdout and stderr when applicable.

The receipt is a coordination lock and manual-recovery aid. It is not a journal for automatic continuation. If it survives interruption, another window refuses to mutate that checkout. After using Git to establish the desired state, the user explicitly clears the receipt; clearing runs no Git command.

## Enter Review

1. Ask VS Code to save dirty documents. Cancellation or failure stops entry.
2. Refuse an existing receipt unless it already describes the same active review in the same window.
3. Record original `HEAD`, its branch when symbolic, the target and step `stashing`.
4. Inspect ordinary `git status --porcelain`. When dirty, run:

   ```sh
   git stash push --include-untracked --message <unique-marker>
   ```

5. Record the resulting `refs/stash` object when Git created a new stash.
6. Run:

   ```sh
   git switch --detach <target-oid>
   ```

7. Mark the receipt `active`.

Ignored files remain in place because `--all` is not used. The workbench does not run reset, clean, force checkout or recursive submodule cleanup.

## Exit Review

1. Ask VS Code to save dirty documents. Review-time changes that prevent switching remain for the user to handle with ordinary Git.
2. Switch to the recorded original branch, or detach at the recorded original commit.
3. If prior work was stashed, run:

   ```sh
   git stash apply --index <stash-oid>
   ```

4. After a successful apply, locate and drop only the stash-list entry whose object matches the recorded object.
5. Remove the receipt and report completion.

Repository restoration defines Exit completion. The workbench does not capture, close, reopen or verify VS Code tabs, groups, previews, selections, focus, layout or scroll positions.

## Failure behavior

Any nonzero Git result stops the transition. Show the working directory, exact redacted command arguments, exit code, stdout and stderr, plus original branch/commit, target and stash object from the receipt.

Do not automatically retry, replay, roll back, resolve conflicts, infer completion from file hashes or run a replacement command. Preserve the receipt and stash. Git's own conflict/recovery mechanisms remain under user control.

## Source fetch and navigation

Fetch and compare exact committed objects independently of checkout entry. Verify remote object identities against GitHub metadata, but do not hash the current worktree as part of source reads. Committed virtual documents, native diffs, anchors and Reviewed marks retain their existing source-generation identities.

Source Sync installs a newer committed generation and reconciles source-dependent review state. It does not silently switch an active checkout or treat working changes as committed review input.

## Verification

Disposable-repository tests cover clean and dirty entry/exit, staged plus unstaged changes on one file, untracked files, detached HEAD, unrelated stashes, concurrent different repositories, same-checkout refusal, failed switch diagnostics, stash conflicts and explicit receipt clearing.

Tests assert observable Git state and returned diagnostics through the checkout module's interface. They do not inject failures between private implementation phases or assert byte-manifest internals.

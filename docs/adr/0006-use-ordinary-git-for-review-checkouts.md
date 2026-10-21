---
status: accepted
supersedes: 0002-preserve-work-in-existing-checkout.md
---

# Use ordinary Git for review checkouts and manual recovery

Use the existing local checkout for PR review. Before entry, ask VS Code to save dirty documents. Preserve staged, unstaged and nonignored untracked work with ordinary `git stash push --include-untracked`, record the resulting stash object, and enter the exact committed review source with `git switch --detach <oid>`.

Exit returns to the recorded original branch or detached commit and runs `git stash apply --index <oid>`. Drop the matching stash entry only after Git reports a successful apply. Repository restoration defines Exit completion; VS Code owns its tab groups, layout, selections, focus and scroll state.

Git is authoritative. The workbench does not build parallel worktree/index byte manifests, classify repository representations, supervise Git child processes, or automatically replay, roll back or repair interrupted commands. A failed command stops the transition and reports the repository, redacted command arguments, exit code, stdout and stderr. The user completes recovery with ordinary Git.

Keep one bounded repository-local receipt containing the window, source, original branch/commit, target commit, stash marker/object and current step. It prevents another workbench window from interleaving a transition in the same checkout and gives the user facts after interruption. Clearing a stale receipt is an explicit acknowledgement and runs no Git command.

This accepts that Git conflicts and interrupted commands require human recovery. The reduced implementation and transparent diagnostics are preferred to stronger automatic-restoration guarantees.

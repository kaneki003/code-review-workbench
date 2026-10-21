---
status: superseded
superseded-by: 0006-use-ordinary-git-for-review-checkouts.md
---

# Preserve prior work while using the existing checkout

> Superseded by [ADR 0006](0006-use-ordinary-git-for-review-checkouts.md). The existing-checkout choice remains, but byte manifests, owned recovery refs, automatic reconciliation and editor-state restoration do not.

Use the existing local repository folder for PR review, with explicit saving, verified stash preservation and restoration of prior work on Exit Review. The owner prefers this familiar Git workflow over a linked worktree or another clone; accept the additional durable recovery and concurrency protocol needed to protect staged, unstaged and new-file work. Keep review-time changes in a separate ordinary stash when the reviewer chooses stash-and-exit or stash-and-Sync; see the [Git/source lifecycle contract](../design/git-source-lifecycle.md) for the accepted transitions, source identities and validation gates.

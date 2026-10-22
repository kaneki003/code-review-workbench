# PR checkout and Exit Review

The earlier clean-only, owned-branch checkout and editor-restoration implementation has been removed. See the current [prior-work walkthrough](prior-work.md) for implementation order, manual recovery and try-out steps.

[ADR 0006](../adr/0006-use-ordinary-git-for-review-checkouts.md) replaces the earlier recovery journal with ordinary Git and a bounded repository-local receipt. [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md) governs the remaining storage coordination migration.

Earlier review records remain historical evidence; they do not describe the current checkout contract or establish platform acceptance.

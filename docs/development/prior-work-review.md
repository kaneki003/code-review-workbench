# Prior-work preservation checkpoint review

Issue: [Preserve prior work during PR review (#23)](https://github.com/kaneki003/code-review-workbench/issues/23).

Fixed comparison baseline: `e85fa114957a628056cc7e78e3aa053c21eaecb9` (main at branch creation). The Standards and Spec reviewers ran independently through the code-review skill. They reviewed `5bdd474` and rechecked the fixes in `7089e9a`.

## Standards

No documented-standard violations found. The tests use the agreed public manager seam with real Git and retain the existing ownership/recovery boundaries.

One low-priority judgment: `cleanCheckoutState(target, allowDirty)` and `CleanCheckoutState` suggested verified cleanliness even when inventory intentionally admitted unfinished work. Resolved by renaming the result to `CheckoutState` and using an explicit `'clean' | 'inventory'` requirement. The reviewer confirmed the judgment was resolved and found no new standards findings in the fix.

## Spec

Two P2 findings in the initial checkpoint:

1. **Retry could not recover a verified unperformed stash/apply.** The worker rejected any saved receipt with a `not-applied` outcome, so recovery could reach the correct original state but remain stuck. The spec requires “a specific recovery/Retry path.” Recovery now checks matching independent/database receipts, repository identity and actual unperformed state, then durably saves a fresh operation identity before any new attempt. Public-action fixtures interrupt before both stash and apply dispatch and complete the recovered round trip.
2. **Preparation failure after preservation left original work stashed.** Only an observed checkout refusal triggered automatic restoration. The spec requires “Known failed entry automatically restores original work only when current facts prove it safe.” Preparation failures now refresh the same owner's lease, reconcile actual facts and attempt restoration only on the safe original path. The original failure remains visible; uncertain processes or changed buffers retain recovery. A concurrent branch-collision fixture verifies the restored bytes, completed receipt and retained original error.

The Spec reviewer rechecked both fixes at `7089e9a`, confirmed both findings were resolved and found no introduced concrete bug. No scope creep was identified.

Initial totals: Standards 0 violations plus 1 naming judgment; Spec 2 P2 findings. All three are resolved. The full fault/interference/platform matrix remains a completion gate for #23; this is a working checkpoint for owner review.

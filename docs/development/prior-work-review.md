# Prior-work preservation review

Issue: [Preserve prior work during PR review (#23)](https://github.com/kaneki003/code-review-workbench/issues/23).

Fixed comparison baseline: `e85fa114957a628056cc7e78e3aa053c21eaecb9` (main at branch creation). The Standards and Spec reviewers ran independently through the code-review skill. They reviewed the initial checkpoint at `5bdd474`, rechecked `7089e9a`, reviewed the completed implementation through `81e24c3`, then checked the final fixes and native fixtures at `e6d1e57`/`10dc129`.

## Initial checkpoint: Standards

No documented-standard violations found. The tests use the agreed public manager seam with real Git and retain the existing ownership/recovery boundaries.

One low-priority judgment: `cleanCheckoutState(target, allowDirty)` and `CleanCheckoutState` suggested verified cleanliness even when inventory intentionally admitted unfinished work. Resolved by renaming the result to `CheckoutState` and using an explicit `'clean' | 'inventory'` requirement. The reviewer confirmed the judgment was resolved and found no new standards findings in the fix.

## Initial checkpoint: Spec

Two P2 findings in the initial checkpoint:

1. **Retry could not recover a verified unperformed stash/apply.** The worker rejected any saved receipt with a `not-applied` outcome, so recovery could reach the correct original state but remain stuck. The spec requires “a specific recovery/Retry path.” Recovery now checks matching independent/database receipts, repository identity and actual unperformed state, then durably saves a fresh operation identity before any new attempt. Public-action fixtures interrupt before both stash and apply dispatch and complete the recovered round trip.
2. **Preparation failure after preservation left original work stashed.** Only an observed checkout refusal triggered automatic restoration. The spec requires “Known failed entry automatically restores original work only when current facts prove it safe.” Preparation failures now refresh the same owner's lease, reconcile actual facts and attempt restoration only on the safe original path. The original failure remains visible; uncertain processes or changed buffers retain recovery. A concurrent branch-collision fixture verifies the restored bytes, completed receipt and retained original error.

The Spec reviewer rechecked both fixes at `7089e9a`, confirmed both findings were resolved and found no introduced concrete bug. No scope creep was identified.

Initial totals: Standards 0 violations plus 1 naming judgment; Spec 2 P2 findings. All three were resolved before the checkpoint walkthrough.

## Completed implementation: Standards

One P2 documented-standard finding: the manifest includes HEAD paths, while the existing repository-facts inventory bounds only indexed/nonignored new paths. A retained file removed from the index and then ignored could bypass the 128 MiB bound before `readFileSync`. This conflicts with the bounded-work requirement in `docs/design/extension-architecture.md`. `e6d1e57` preflights the actual HEAD/index/new-path union for count and cumulative bytes before reading contents. A public Enter fixture failed before the fix and now refuses before stash, preserving the original HEAD, index and retained file.

One low-priority possible Duplicated Code judgment: the prior-work tests had their own copy of the new shared editor fixture. They now use `checkoutEditors`.

The reviewer confirmed both findings were resolved. No new concrete standards or test-seam findings were identified in the operation-specific native diagnostic label or the real installed-host untitled/save-hook fixtures. Diagnostics remain host-owned.

## Completed implementation: Spec

No new concrete implementation defect or scope creep was identified. Review confirmed that cleanup requires matching ownership receipts and exact reference values after verified completion, leaving ordinary stashes untouched.

One partial acceptance-coverage finding: the initial expanded matrix used crashes after stash/apply but exercised actual SQLite/native publication failures only at entry intent. `10dc129` adds four public recovery cases for native directory-flush and SQLite observed-commit failures after both stash creation and application. All four restored the exact original branch/index/files and retained the unrelated stash. The interrupted stash-before-object fixture additionally inserts a newer unrelated stash; recovery finds its unique marker and retains both objects.

The reviewer confirmed the coverage finding was resolved and found no defect in the inventory fix or native buffer-refusal assertions. Full installed-host execution is still failing in the browser writer; that cause is unknown. Two local runs passed the preservation portion before failing in the later discard writer, while another failed before reaching it. Windows/minimum-Git acceptance remains outstanding, as requested by the owner; no review treats CI as green.

Full validation also exposed an older clean-checkout assertion expecting `blocked` after the owner manually returns to the original branch and chooses Continue. The manager now retains the saved active review in this refusal, so the truthful result is `recovery`. The Spec reviewer confirmed that returning recovery context keeps the required Restore action available for clean and prior-work reviews alike. The test now asserts that context while retaining the exact Restore instruction, no editor restoration and unchanged HEAD reflog checks; the focused scenario passes.

Final totals: Standards 1 P2 violation plus 1 duplication judgment, both resolved; Spec 1 partial acceptance-coverage finding, resolved. No outstanding concrete finding in either reviewed axis. The open platform/host validation limits are recorded in [the feature walkthrough](prior-work.md).

## Git attributes follow-up

Fixed comparison baseline: `4244d5de6ab46c3ea783a9f4647adaf4efef6579`. The reviewers independently checked the approved canonical/raw conversion change and rechecked its fixes before the follow-up commit.

### Standards

No documented-standard violations or material smell findings. Conversion logic stays in the Git connection, scratch writes retain explicit limits, and the public Enter/Exit/Recover fixtures use disposable real Git. The frozen protocol-1 fingerprint fixture is deliberate compatibility evidence: directory identities vary between runs, so a static digest cannot represent the older record. The new 9 MiB integration fixture alone receives a 60-second budget after exceeding the ordinary 20-second budget in the full run; existing fixture timeouts and assertions are unchanged.

### Spec

Two findings were fixed and rechecked:

1. **P1: adding attributes to every repository fingerprint broke older saved reviews.** Their protocol-1 original/clean identities could never match after upgrading. Repository/check-out fingerprints now retain the previous algorithm. New preservation records track conversion policy separately and recheck it after preview, before stash/apply, and before Exit/recovery while the PR is still checked out. Old manifests without a policy record require nonconverting rules. Two regressions freeze the previous identity format and reopen clean/unfinished reviews through the public Restore action.
2. **P2: target-only working-tree fallback escaped preflight.** A target index without `.gitattributes` can still use an ignored working-tree attribute file for a new target path. Target preflight now checks both cached and ordinary attribute lookup through the scratch target index. A public clean Enter fixture with ignored encoding rules failed before this fix and now refuses before checkout or a saved transition.

Both compatibility cases and the ignored-attribute case failed before their fixes and all three pass afterward. The Spec reviewer confirmed both findings were resolved and found no new concrete defect or scope creep. No platform acceptance is inferred from this review.

Follow-up totals: Standards 0 findings; Spec 1 P1 and 1 P2 finding, both resolved. No outstanding concrete finding in either axis.

Follow-up validation: all 316 tests across 15 files pass. Current/minimum macOS installed hosts (VS Code 1.143.0/1.141.2) each pass all seven checks, including native prior-work preservation with committed LF attributes. Earlier platform CI failures and minimum-Git acceptance remain open; see the walkthrough for the complete measured limits.

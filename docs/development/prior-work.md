# Preserve prior work during PR review

Implementation for [issue #23](https://github.com/kaneki003/code-review-workbench/issues/23), awaiting owner review in [draft PR #36](https://github.com/kaneki003/code-review-workbench/pull/36). Enter/Exit preserve supported prior work and reconcile interrupted preservation, restoration and artifact cleanup. Windows CI and current installed-host validation remain unresolved. The owner requested finishing the implementation before resolving CI; this document does not claim platform acceptance or ticket closure.

## Walk through the change

1. **Record saved work before Git changes it.** The existing native editor adapter saves normally and captures the original tabs. [ReviewManager](../../src/application/review-manager.ts) then starts a durable checkout intent. [WorkManifest](../../src/application/prior-work.ts) records index entries separately from saved disk content, including missing paths and nonignored new files. Each content identity is a Git blob hash of the actual bytes. This distinguishes staged and unstaged changes on one file without making unfinished work reviewable source.
2. **Prove the exact backup before checkout.** [prior-work.ts](../../src/connections/prior-work.ts) inventories supported representations. [store-worker.ts](../../src/connections/store-worker.ts) records the original HEAD, prior stash observation and unique marker before the typed `stash push --include-untracked` operation. The existing guarded process/journal protocol records child identity and outcome. The verifier compares the stash's index, tracked-content and new-file trees with the manifest, then pins that exact object under `refs/code-review-workbench/recovery/<stash operation ID>/prior-work`. A Git reference keeps the object reachable even if the ordinary stash list changes. Checkout follows the acknowledged pin and clean original facts.
3. **Verify restoration before completion.** Exit restores the original branch/commit using the existing protected checkout, then applies the exact object with `stash apply --index`. It verifies the disk/index manifest before restoring editors and recording completion. A refused checkout can automatically restore prior work when the actual original checkout is still safe. Interrupted stash/apply operations reconcile real files, objects, reflog markers and receipts; recovery never assumes the latest stash belongs to the workbench or repeats an uncertain apply.
4. **Retry only proven nonexecution.** Recovery can use a fresh operation identity when matching durable receipts and actual files prove the previous attempt did nothing, or a prepared intent proves its Git child was never armed. An uncertain or partially applied stash cannot be replayed. Fresh checkout attempts keep their earlier identities for owned-artifact cleanup. There are at most 32 such attempts; beyond that, recovery offers explicit restoration.
5. **Release only proven owned protection.** After the original manifest, native editors and completion receipt are verified, cleanup compares each owned reference with its expected object and matching operation receipts. It removes unchanged original/prior-work pins and eligible merged review branches. Moved, unproven or unmerged references remain and are named in the result. The ordinary operation-tagged stash remains as a named backup; cleanup never drops a shifting stash ordinal. Exit reports whether that exact object is still in the stash list, including when another writer has removed it.

No new framework is introduced. The existing SQLite worker, independent recovery journal, native process guard, expected-value reference writes and native editor adapter carry the new steps. A clean starting checkout still uses the existing path and creates no stash. Committed diffs and drafts retain their original exact-source identities.

## How to exercise the feature

Use the disposable fixtures:

```sh
pnpm validate
pnpm exec vitest run tests/prior-work.test.ts tests/prior-work-recovery.test.ts tests/prior-work-interference.test.ts
pnpm test:host
CRW_VSCODE_VERSION=1.141.2 pnpm test:host
```

The public manager fixture stages one version of a file, writes another version on disk, renames a file and creates a new file alongside an unrelated stash. Enter must show the exact committed PR with a clean tree; Exit must restore the original branch, staging and bytes. The installed-host fixture adds actual unsaved editor text, untitled-buffer refusal and a continuing save hook. It verifies native selections/tabs after manager recreation. Run these only through their disposable fixtures; their Git mutations never target a real user checkout.

| Fixture                                                                        | What it demonstrates                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [prior-work.test.ts](../../tests/prior-work.test.ts)                           | Full Enter/Exit, separate staged/disk bytes, binary/deleted/mode/renamed files, detached HEAD, refusal rollback and recovery with a newer unrelated stash.                                                                                                                                                          |
| [prior-work-recovery.test.ts](../../tests/prior-work-recovery.test.ts)         | 42 injected crash/storage failures across intent, stash, pins, checkout, apply, verification, editor/completion receipts and cleanup; Continue after unperformed checkout; reordered ordinary stashes. Native directory-flush and actual SQLite commit failures are exercised after stash creation and application. |
| [prior-work-interference.test.ts](../../tests/prior-work-interference.test.ts) | Concurrent file/stash writers, moved/missing branches or protection, a corrupt stash object, partial failed apply, owner repair then Retry, unsupported-state fallback, ignored dependencies/environment, raw CRLF bytes and inventory/journal limits.                                                              |
| [host/readiness.ts](../../tests/host/readiness.ts)                             | Actual native saves, dirty/untitled buffers and save hooks, restored tabs/selections/index/disk/new files after manager recreation. Current full-host failure is recorded below.                                                                                                                                    |

## Current representation and recovery limits

The first preservation path supports ordinary files with exact byte representations and Git executable modes. Unsupported attributes/filters, line-ending conversion, unusual/non-ASCII/control-character paths, case collisions, symlinks, special index flags, sparse/split index, submodules/nested repositories, nonstandard permissions and incomplete Git operations stop before preservation. The existing exact-source reader remains available without switching. Save cancellation, unknown/untitled buffers and unstable host state retain the existing refusal behavior.

Recovery data, including the editor snapshot and full manifest, shares the existing 60,000-byte checkout-record bound. Initial preservation records must fit 56,000 bytes, reserving room for proof and bounded recovery-attempt identities before stash. Repository inventory is limited to 10,000 paths/128 MiB, including retained files removed from the index and subsequently ignored. Unsupported or oversized states refuse before stash. Git's disposable index stat cache is excluded from restoration equality.

If recovery cannot prove the recorded state, keep the saved record and protection. Resolve only the reported interference, then use **Recover PR Checkout** with Restore or Continue. A partial apply must be resolved to the exact recorded index/files; Retry does not run apply twice. Missing or moved protection and original branches require restoring the exact expected object/ref before automatic recovery can continue. Never substitute the latest ordinary stash. Review-time edits still stop Exit; their separate stash-or-stay flow belongs to #24.

## Validation

On macOS arm64 with Git 2.56.0, development Node 24.22.0 and pnpm 12.11.2:

- Final `pnpm validate` passed formatting, TypeScript and all 281 tests across 14 files in 272.95 seconds. The three prior-work files contain 74 public-action cases, including 42 injected crash/storage boundaries. This extends the initial checkpoint's 219 tests across 12 files.
- The initial packaged host passed all seven checks on minimum VS Code 1.141.2 and current 1.142.0, including actual unsaved input, staging, a new file, manager recreation and verified editor restoration. The minimum host reports Node 24.21.0, Electron 43.7.7, Chromium 150.0.7871.250 and SQLite 3.53.4.
- With the additional untitled/save-hook fixtures, two local host runs reached the later draft-discard browser failure after the preservation checks. A third run failed earlier in the draft writer, before those checks. Each full run reported six passing/one failing: the browser target did not render the installed writer. The cause is not established, and these runs are not passing host evidence.
- Checkpoint [CI run 39478542150](https://github.com/kaneki003/code-review-workbench/actions/runs/39478542150): both Ubuntu and macOS cells passed; Windows cells timed out in the unperformed stash/apply recovery tests. Windows diagnosis is deferred at the owner's request until the PR implementation is complete. No timeout, skip or assertion was weakened.
- The independent [Standards and Spec review](prior-work-review.md) records the findings, fixes and remaining validation limitations.

The completed fault/interference implementation still needs current Windows CI, a passing final installed-host run and minimum/current Git/platform acceptance before advertising those support combinations. Keep the PR in draft for owner review.

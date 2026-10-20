# Preserve prior work during PR review

Working checkpoint for [issue #23](https://github.com/kaneki003/code-review-workbench/issues/23). The core Enter/Exit path and the first interruption fixtures are implemented. The full failure-boundary and supported-platform acceptance matrix remains open; this checkpoint does not complete the ticket.

## Walk through the change

1. **Record saved work before Git changes it.** The existing native editor adapter saves normally and captures the original tabs. [ReviewManager](../../src/application/review-manager.ts) then starts a durable checkout intent. [WorkManifest](../../src/application/prior-work.ts) records index entries separately from saved disk content, including missing paths and nonignored new files. Each content identity is a Git blob hash of the actual bytes. This distinguishes staged and unstaged changes on one file without making unfinished work reviewable source.
2. **Prove the exact backup before checkout.** [prior-work.ts](../../src/connections/prior-work.ts) inventories supported representations. [store-worker.ts](../../src/connections/store-worker.ts) records the original HEAD, prior stash observation and unique marker before the typed `stash push --include-untracked` operation. The existing guarded process/journal protocol records child identity and outcome. The verifier compares the stash's index, tracked-content and new-file trees with the manifest, then pins that exact object under `refs/code-review-workbench/recovery/<stash operation ID>/prior-work`. A Git reference keeps the object reachable even if the ordinary stash list changes. Checkout follows the acknowledged pin and clean original facts.
3. **Verify restoration before completion.** Exit restores the original branch/commit using the existing protected checkout, then applies the exact object with `stash apply --index`. It verifies the disk/index manifest before restoring editors and recording completion. A refused checkout can automatically restore prior work when the actual original checkout is still safe. Interrupted stash/apply operations reconcile real files, objects, reflog markers and receipts; recovery never assumes the latest stash belongs to the workbench or repeats an uncertain apply.

No new framework is introduced. The existing SQLite worker, independent recovery journal, native process guard, expected-value reference writes and native editor adapter carry the new steps. A clean starting checkout still uses the existing path and creates no stash. Committed diffs and drafts retain their original exact-source identities.

## How to exercise the checkpoint

Use the disposable fixtures:

```sh
pnpm check
pnpm exec vitest run tests/prior-work.test.ts
pnpm test:host
```

The public manager fixture stages one version of a file, writes another version on disk, renames a file and creates a new file alongside an unrelated stash. Enter must show the exact committed PR with a clean tree; Exit must restore the original branch, staging and bytes. Other fixtures interrupt stash creation before object recording, interrupt apply before its receipt and refuse checkout on an ignored-file collision. The installed-host fixture exercises actual unsaved editor text, staging, new-file work and restored native selections/tabs after manager recreation.

## Current representation and recovery limits

The first preservation path supports ordinary files with exact byte representations and Git executable modes. Unsupported attributes/filters, line-ending conversion, unusual/non-ASCII/control-character paths, case collisions, symlinks, special index flags, sparse/split index, submodules/nested repositories, nonstandard permissions and incomplete Git operations stop before preservation. The existing exact-source reader remains available without switching. Save cancellation, unknown/untitled buffers and unstable host state retain the existing refusal behavior.

Recovery data, including the editor snapshot and full manifest, shares the existing 60,000-byte checkout-record bound. Oversize records refuse before stash. Repository inventory retains the existing 10,000-file/128 MiB bounds. Git's disposable index stat cache is excluded from restoration equality.

The prior-work stash and its owned pin remain after verified completion at this checkpoint; Exit reports that retention. No ordinal-based stash deletion occurs, so unrelated or reordered user stashes remain intact. Review-time edits still stop Exit; their separate stash-or-stay flow belongs to #24.

Before completing #23, extend fault coverage across every intent, stash, pin, checkout, apply, verification and cleanup boundary; exercise interference, missing/tampered artifacts and retry paths; finish conservative artifact handling; and run the minimum/current VS Code matrix on Windows, Linux and macOS. Record observed results without treating a local test as platform-wide evidence.

## Checkpoint validation

On macOS arm64 with Git 2.56.0, development Node 24.22.0 and pnpm 12.11.2:

- `pnpm validate` passed formatting, TypeScript checking and all 219 tests across 12 files. The 12 new public-manager fixtures cover exact prior-work restoration, binary bytes/deletion/executable staging, unsupported-state fallbacks, known preparation/checkout refusal and interrupted stash/apply success or verified nonexecution.
- The packaged host passed all seven checks on minimum VS Code 1.141.2 and current 1.142.0, including actual unsaved input, staging, a new file, manager recreation and verified editor restoration. The minimum host reports Node 24.21.0, Electron 43.7.7, Chromium 150.0.7871.250 and SQLite 3.53.4.
- The independent [Standards and Spec review](prior-work-review.md) found two recovery defects and one naming judgment. Both defects have regression fixtures, and both reviewers confirmed their findings were resolved.

Windows/Linux, minimum Git, the exhaustive failure boundaries and full preservation acceptance remain unverified by these local results.

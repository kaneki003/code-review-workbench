# Shared private-store checkpoint (#18)

Status: canonical store ownership is implemented. This is a working checkpoint for [Protect shared review state across windows](https://github.com/kaneki003/code-review-workbench/issues/18), not completed #18. The owner approved the native helper on 17 October 2026. Review entry, review-content writes and repository mutations remain unavailable.

## Try it

Build with Node 24.15–24.x, pnpm 12.11.2, Python and a C++ toolchain:

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
pnpm test:host
```

Install the VSIX built for your OS/CPU. In a trusted local Git repository, run **Code Review Workbench: Open Private Store**. Another window reports the owner's location. **Release Private Store** lets a later window open the same store. **Check Readiness** only inspects ownership; it does not claim or initialize storage.

The first explicit open creates private app-owned files. It does not start a review or change Git. Closing the extension attempts release; an interrupted or uncertain outcome remains blocked.

## Walk me through the diff

1. `src/application/private-store.ts`: public request/reply types. A lease is proof for one ownership turn. Its token is random; its fence is an increasing number that rejects requests from an older owner. The incarnation identifies the current store lineage independently of database copies.
2. `src/application/review-manager.ts`: queues host-owned requests, checks workspace/trust/runtime, creates request IDs and retains the current lease. Readiness, open, renew, release and handoff use this interface.
3. `src/connections/store-location.ts` and `shared-store.ts`: resolve the OS account's real home and candidate data directory; communicate with the packaged worker. HOME/USERPROFILE do not choose the rendezvous. Relative data directories are rejected.
4. `src/connections/store-worker.ts`: owns the OS guard, canonical registration and ownership transitions. It never executes a Git mutation. `recordRepositoryIntent` is a host-only test seam, absent from the command palette. It records a pending recovery barrier; it does not authorize external execution and has no completion/clear API.
5. `store-records.ts` and `store-database.ts`: validate independent records and the worker-only SQLite database. Metadata uses owner/account scopes, expected revisions, deduplication and fencing. Unknown/newer formats and damaged files are preserved and refused.
6. `native/guard.cc`: permanent OS lock, verified process-start identity, local-directory checks, private permissions and atomic record publication. `scripts/build*.mjs`, `scripts/package.mjs` and `.vscodeignore` ship the matching binary and workers.
7. `tests/shared-store.test.ts`, native tests and `tests/host/readiness.ts`: real processes/filesystems and the installed production worker. [Validation and remaining work](shared-store-validation.md).

One Open action flows through the VS Code command → manager queue → worker → permanent OS guard → fixed registry/control files → SQLite claim transaction → durable owned record → reply. A second window never opens account content; its busy response contains only status, explanation and owning location.

## Ownership protocol

The fixed rendezvous is `<os.userInfo().homedir>/.code-review-workbench/store-location.json`. A permanent sibling guard, `.code-review-workbench.guard`, is locked **before** creating the rendezvous directory. This closes the mkdir/lock registration race. Release closes the exact handle; it never deletes or replaces the guard pathname.

POSIX uses nonblocking `flock`; Windows uses `LockFileEx`. Handles do not propagate to ordinary children. The worker rechecks the live handle/path identity before publication and mutations. A heartbeat is diagnostic only. A free OS lock does not by itself allow takeover: a matching live prior host, interrupted phase, pending intent or mismatched database/control identity requires recovery.

First registration chooses one root and stable store/local-scope IDs. Later processes honor that root despite different data-directory variables. An existing unregistered folder or orphan guard is recovery. Roots must be private, canonical, supported local filesystems outside repositories. Initial allowlist: APFS, NTFS, ext4, XFS, Btrfs. Network/redirected/unsupported storage stops writes without relocation.

Normal claim publishes `claiming`, commits the next fence/owner/revision, then publishes `owned`. Release publishes `releasing`, commits its receipt, publishes `released`, closes SQLite, then releases the OS guard. Incomplete transitions refuse recovery guesses. Handoff durably reserves the next claim for one named window and random offer token; a third window or failed transfer cannot use a timeout to take over.

SQLite uses the embedded `node:sqlite` driver only in the worker. WAL, FULL synchronization, foreign keys, secure deletion and a bounded busy timeout are set and checked. SQL transactions never wait for external work. Replies follow the commit and required independent publication. Missing, newer or damaged databases do not become empty replacements.

The reservation-only seam records canonical worktree/common-Git-directory identities in sorted order. The global store guard supplies exclusion at this checkpoint. Independent pending intent is published before its SQLite projection; acknowledgment waits for both. Once pending, renew/release/handoff/further reservations/reclaim are blocked. A fixture can then leave a child running and kill its host: the pending record continues blocking takeover before and after that child exits. This proves a conservative barrier, not safe dispatch or child settlement.

## Independent record durability

Records are bounded JSON recovery metadata, separate from authoritative SQLite and any future restorable backup. Publication creates a unique private temporary file, writes the whole record, flushes it, atomically replaces the destination and waits for the platform durability steps before acknowledgment.

- POSIX: private 0600 files, file sync (`F_FULLFSYNC` on macOS), rename, parent-directory fsync; macOS also performs full synchronization after publication. Creating app directories also syncs the parent.
- Windows: protected current-user DACL, write-through temporary file, `FlushFileBuffers`, replacement with `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`, then reopen/flush the published file. Private directory creation uses a write-through move from a unique private directory.

See Microsoft's [MoveFileEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw), [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers), and SQLite's [atomic-commit discussion](https://sqlite.org/atomiccommit.html). The protocol uses the combined sequence; a rename flag alone is not the durability claim. Tests exercise real publication and process crashes, not a simulated hardware power cut. Full publication/flush/commit fault injection remains an acceptance gate.

## Approved packaging change

The approved bridge amends the earlier JavaScript-only [packaging boundary](../design/extension-architecture.md#build-package-management-and-tests). `node-gyp` 13.1.0 builds against Electron 43.7.7 headers with Node-API 8. The VSIX declares `darwin-arm64`, `win32-x64` or `linux-x64`; no user install hook or compiler is required.

Developers need Xcode Command Line Tools on macOS, C++/make on Linux or Visual Studio C++ Build Tools on Windows, plus Python. Gyp headers use a private temporary cache because Unix include paths containing spaces fail. Source checkout paths may contain spaces. [Node-API](https://nodejs.org/download/release/v24.21.0/docs/api/n-api.html), [node-gyp prerequisites](https://github.com/nodejs/node-gyp/blob/v13.1.0/README.md), [Electron Windows delay loading](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules#a-note-about-win_delay_load_hook).

## Still required before #18 is complete

- Action-specific expected HEAD/index/file facts and a Git target boundary that cannot redirect to another repository.
- Verified descendant settlement/containment, independent observed-outcome receipts, completion and explicit recovery before dispatch is enabled. Top-level Git exit is insufficient.
- Failure injection across each intent, publication, commit, dispatch and receipt boundary; broader filesystem/durability proof. No automatic recovery or replay is implemented.

Review/content/normal Git mutations stay disabled. No migration, backup restore, deletion or full review schema is introduced here. The [earlier helper evidence](native-helper-validation.md) and [initial blocker evidence](shared-state-validation.md) are historical checkpoints.

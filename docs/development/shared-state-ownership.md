# Shared private-store ownership (#18)

The shared store, fenced ownership, typed Git operation and explicit recovery are implemented for [#18](https://github.com/kaneki003/code-review-workbench/issues/18). Review entry and review-content features belong to later tickets. This implementation provides the guard they must use; it does not add checkout, stash, publication or an arbitrary command runner.

## Run and try it

Use Node 24.15–24.x, pnpm 12.11.2, Python and a C++ toolchain:

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
pnpm test:host
```

Install the VSIX for your OS/CPU, open a trusted local Git repository and run **Open Private Store**. Another window shows the owner's location. **Release Private Store** lets a later window claim the same store. **Check Readiness** only inspects; it never claims or initializes storage. **Recover Private Store** inspects an interrupted operation and releases it only after its process and actual Git outcome can be established. An unknown child, changed repository, damaged record or unsupported format stays blocked with an explanation. No recovery command replays Git or creates an empty replacement.

An explicit first Open creates app-owned files outside the repository. Closing the extension attempts release. The installed tests use isolated homes and profiles; they do not open the real user's private store.

## Walk me through the diff

1. `src/storage/contracts.ts`, `review-manager.ts`, `src/extension.ts`: host-owned IDs and leases, ordered actions and the Open/Release/Recover commands. A lease proves one ownership turn. Its random token and increasing fence reject old callbacks. The incarnation identifies the store lineage independently of database snapshots.
2. `store-location.ts`, `shared-store.ts`, `store-worker.ts`: OS-user discovery, worker transport, permanent guard, canonical registration, claim/release/handoff and reconciliation.
3. `store-records.ts`, `store-database.ts`: independent record validation and worker-only SQLite. Every metadata mutation checks the owner, scope, incarnation, fence and expected revision. Duplicate IDs have one durable result.
4. `repository-operation.ts`, `reference-storage.ts`, `native/child.cc`: exact Git targets, repository facts, paused process creation, explicit start and settlement. A differing workspace path must name the same actual directory (device/file identity); this accepts VS Code drive-letter case and macOS path aliases while rejecting another folder. The only mutation is a compare-and-swap update under `refs/code-review-workbench/`. Callers cannot supply Git arguments, executables, environment or another repository path.
5. `native/guard.cc`, build/package scripts: OS locks, process-start evidence, local/private paths and durable atomic publication. The VSIX ships the matching native binary and workers.
6. Public manager/process tests, native tests and installed-host tests exercise the real implementation. `storage-diagnostics.ts` supplies host-only failure injection at durability/process steps. It is absent from settings, webviews and repository inputs. [Validation](shared-store-validation.md).

One operation flows through prepare → independent intent → SQLite projection → paused child with verified PID/start → independent armed record and projection → final ownership/repository check → start → verified process settlement and Git result → independent receipt → SQLite projection → remove pending barrier. Release waits until that sequence settles.

## One canonical store and owner

The fixed registry is `<os.userInfo().homedir>/.code-review-workbench/store-location.json`; HOME/USERPROFILE cannot redirect it. A permanent sibling `.code-review-workbench.guard` is locked before directory creation, closing the mkdir/lock registration race. POSIX uses nonblocking `flock`; Windows uses `LockFileEx`. Release closes the exact handle and never deletes the guard pathname. Revalidation checks that the live pathname still names that handle.

First registration chooses stable store/local-scope IDs and one root. Later profiles/copies honor that root despite different data-directory variables. Existing unregistered storage, orphan publication or missing control records require recovery. Roots/rendezvous must be private, canonical supported local filesystems outside repositories. Initial allowlist: APFS, NTFS, ext4, XFS, Btrfs. Network/redirected/unsupported roots and relative data locations do not trigger relocation or a fallback store.

Claims publish `claiming`, commit the next fence/owner/revision, then publish `owned`. Release publishes `releasing`, commits its receipt, publishes `released`, closes SQLite, then unlocks. Interrupted or disagreeing transitions stay blocked. A free lock or old heartbeat is insufficient: a matching live prior host prevents takeover. Handoff reserves a claim for one named window and random offer token; failed handoff cannot become timeout takeover. Busy responses expose only status, explanation and owner location. Account scopes remain separate without bypassing OS-user exclusion.

SQLite is authoritative and opens only in the packaged worker. WAL, FULL synchronization, foreign keys, secure deletion and bounded busy handling are set and checked. No SQL transaction waits for Git. Success follows the commit and required independent publication. Newer formats, corruption or a restored database disagreeing with independent incarnation/fence/revision are refused without replacing files. The operation projection is baseline metadata, not a review-content schema or JSON fallback.

## Typed Git and process lifetime

Prepare captures canonical worktree/common-Git-directory scopes in sorted order, per-worktree Git-directory identity, HEAD, index/staged entries and tracked/nonignored file fingerprints. No file contents are retained in recovery records. The current bound is 10,000 files / 128 MiB; exceeding it blocks the operation. The global store guard and worker queue serialize cooperating workbench operations. External Git clients are not locked out; unexpected facts stop dispatch.

Execution binds Git's directory, common directory, worktree and index to those facts. It checks the exact expected old reference through Git's own compare-and-swap. The target stays in the workbench namespace. Ref and reflog ancestors must be canonical; linked/shared files are refused. Their existing identities are captured and checked again before start, then checked after settlement and during recovery. The initial operation supports Git file-based refs. Unchanged values are refused before an intent is created. Repository hooks, filesystem monitors, lazy fetching and inherited Git/config/injection overrides are disabled. A native Git executable is required; script wrappers and arbitrary commands are unsupported. These restrictions exclude callbacks that could launch detached children. Checkout/filter/stash/terminal execution needs its own future typed contract.

POSIX moves private descriptors above standard input/output/error, including when the host has closed them, then creates a new process group with a private close-on-exec start socket. The child closes inherited descriptors and performs only async-signal-safe operations before exec. It cannot exec Git until the worker sends the start byte. If the worker dies first, EOF cancels the child. Linux closes inherited descriptors in the forked child through the kernel operation: Chromium's libc `close()` interceptor otherwise checks a copied parent ownership table and can trap before exec. Parent cleanup still uses normal `close()`. This avoids a dependency on Chromium's private reset API. See its [ownership contract](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/files/scoped_file.h) and [interceptor](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/files/scoped_file_linux.cc). After exec, a Git child can survive host death: the armed record holds its verified identity and keeps takeover blocked until both that process and its group settle. Process groups are not advertised as a sandbox for arbitrary detached programs.

Windows creates the process suspended, assigns it to a unique named job with kill-on-last-close and no breakaway permission, then resumes only after the armed record is durable. Child and job handles are not inherited. Polling checks process exit and zero active job processes. Recovery also checks the named job; a dead parent alone never serves as settlement evidence.

## Receipts and recovery

Each operation has an independent `operation-<id>.json`, bound to its original store/incarnation/fence/token/account scope. Prepared, armed and observed records precede their database projections. An observed receipt is retained after the pending barrier is removed. Losing acknowledgment therefore cannot authorize replay. Receipt lookup checks the original scope and agreement with SQLite.

Recovery holds the permanent OS guard, proves the old host cannot continue (or that the caller is the current owner), checks the recorded child/group/job, original account, repository facts and actual reference. It records applied/not-applied without running Git again, then releases the old ownership turn. A single known unacknowledged projection revision can be reconciled; lower or unrelated revisions cannot. Missing child evidence, untyped old intents, conflicting receipts, changed files/HEAD/index, unknown locks or ambiguous ownership publication stay protected for manual recovery. No force-clear or time-based stealing action exists.

Backups/restoration, migrations of future review content and deletion belong to their own storage work. Restoring an old database does not roll back canonical identity or authorize replay.

## Independent publication and packaging

Records contain minimal metadata, apart from restorable database snapshots. Publication writes a unique private temporary file, flushes, atomically replaces and waits for the platform durability steps before acknowledgment:

- POSIX: 0600 files, file sync (`F_FULLFSYNC` on macOS), rename, parent fsync; macOS performs full synchronization again after publication. App-directory creation syncs the parent.
- Windows: explicit current-user owner/protected DACL, write-through file, `FlushFileBuffers`, `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`, reopen and flush the published file. Directory creation uses a write-through move of a unique private directory.

This is the combined protocol, not a rename-flag-only claim. Tests inject write, file-flush, rename and final-durability failures and real worker/process crashes. They do not simulate hardware power loss or certify every volume. [MoveFileEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw), [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers), [SQLite atomic commit](https://sqlite.org/atomiccommit.html), [Windows jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The owner approved the native bridge on 17 October 2026, amending the earlier JavaScript-only packaging boundary. `node-gyp` 13.1.0 builds Electron 43.7.7 / Node-API 8 assets for macOS arm64, Windows x64 and Linux x64. Users need no compiler or install hook. Developers need Python plus Xcode Command Line Tools, Linux C++/make or Visual Studio C++ Build Tools. Headers use a private temporary cache because gyp's Unix include paths cannot contain spaces; source paths may contain spaces.

# Superseded implementation note

> This walkthrough records the earlier native global-ownership checkpoint. [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md) supersedes it with concurrent SQLite access and repository-scoped checkout coordination.

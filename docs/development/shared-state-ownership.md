# Shared-state ownership gate (#18)

Status: blocked at the packaging decision, 17 October 2026. This is a working checkpoint for [Protect shared review state across windows](https://github.com/kaneki003/code-review-workbench/issues/18), not a completed store implementation or an accepted architecture change.

Readiness now reports ownership as **Blocked**, even when Git and the packaged in-memory SQLite probe pass. Review entry and private-state writes remain unavailable. No canonical registry, guard, private database or recovery record is created by this checkpoint.

## Blocker and decision requested

The [technical design](../design/technical-design.md#processes-modules-and-public-boundaries) requires a concrete, proven guard before mutations. The [storage contract](../design/private-state-storage.md#one-active-review-and-operation-ownership) also requires independent recovery files with validated atomic publication and platform-specific durability. The current VSIX bundles JavaScript and uses Node built-ins; it ships no native runtime bridge.

**Proposal for owner review:** allow a small worker-loaded native bridge, packaged for Windows x64, Linux x64 and macOS arm64. It would expose OS file locking, process-start identity, local-filesystem validation and durable recovery-file publication. Keep authoritative review data in the selected built-in SQLite worker. No independent background service or end-user compiler/install step is proposed.

This changes the [packaging boundary](../design/extension-architecture.md#build-package-management-and-tests): native assets need explicit build/copy/package rules and installed-host checks. Approval would authorize implementing and testing the bridge; it would not establish the guard as safe or enable writes by itself. No dependency or native binary has been added here.

## Evidence and alternatives

Inspected against the selected embedded Node 24.21.0 API/source on 17 October:

| Candidate                                                   | What it establishes                                       | Gap for this contract                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Atomic `mkdir` / exclusive file creation                    | One initial pathname creator                              | No proven token-safe release/reclaim. A reclaimer can inspect A, pause, then delete B's replacement guard. An orphan publication is uncertain.                                                                                                                                       |
| Heartbeat / PID existence                                   | A recent callback or a currently existing PID             | A delayed owner can still run. PID reuse needs OS process-start evidence; host death does not settle a child.                                                                                                                                                                        |
| SQLite ownership row                                        | Transactional row updates                                 | Not exclusion across a later external Git effect.                                                                                                                                                                                                                                    |
| Separate SQLite connection holding an exclusive transaction | Real SQLite filesystem locking while the connection lives | A viable candidate for exclusion, but connection death releases protection while an external child may survive. It still needs durable outstanding-operation records and identity/reconciliation. It does not implement the accepted independent recovery-file publication protocol. |
| Native bridge in the worker                                 | Direct access to the needed OS primitives                 | Packaging decision and all crash/concurrency/platform fixtures remain outstanding. Proposed, not proven.                                                                                                                                                                             |

Node's [filesystem API](https://nodejs.org/download/release/v24.21.0/docs/api/fs.html) exposes exclusive creation, rename and synchronization, but no direct `flock`/`LockFileEx` interface. Its [process API](https://nodejs.org/download/release/v24.21.0/docs/api/process.html#processkillpid-signal) documents signal zero as an existence check, not start identity. This is an API inventory, not a claim that every possible built-in-only protocol is impossible.

The pinned [Windows libuv implementation](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/fs.c) uses `MoveFileExW` with replacement for rename and `FlushFileBuffers` for file sync. Node rename has no write-through option. Microsoft's [MoveFileEx flags](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) distinguish write-through behavior. These facts do not prove that adding a flag alone durably publishes a same-volume rename; the Windows file/directory durability protocol still needs validation. A successful temporary-file flush followed by rename is insufficient evidence by itself.

On macOS, the pinned [Unix libuv implementation](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/unix/fs.c) already attempts full synchronization with fallback. That is useful evidence, but it does not prove every filesystem or the complete recovery-file publication protocol.

[SQLite locking](https://sqlite.org/lockingv3.html) protects database access; it does not make database transactions atomic with Git effects. Moving control records into another SQLite database would change the accepted file protocol and still require crash/child/identity proof. It is an alternative decision, not an implemented fallback. Unbundled OS commands would introduce their own availability and packaging prerequisites.

## Proposed protocol to prove after approval

1. Resolve the fixed rendezvous from `os.userInfo().homedir`. Validate the rendezvous and registered root as supported local filesystems. Acquire an OS lock on a permanent guard file there before registration or maintenance. Never unlink/replace the guard file as release or reclaim. Missing/malformed existing control records require recovery.
2. Under that lock, discover/register exactly one store. Publish a versioned control record durably before acknowledging a claim: random owner token, OS-verified host process/start identity, store identity/incarnation, increasing fencing generation and window location. Account changes cannot create a second owner. Readers see location and status only.
3. Use nonblocking exclusive `flock` on supported POSIX filesystems and `LockFileEx` on Windows as candidate guard primitives. [Linux lock lifetime](https://man7.org/linux/man-pages/man2/flock.2.html) and [Windows lock lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) differ; test each platform. Windows [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) supplies creation-time evidence. POSIX identity acquisition also needs its concrete implementation and fixtures.
4. Serialize canonical worktree/common-Git-directory scopes in a stable order. Revalidate token/incarnation/fence and expected repository facts before external effects. Commit both database intent and independent recovery facts before dispatch. Transactional fencing, expected revisions and request deduplication stay in the worker.
5. Treat every interrupted dispatch as unresolved until actual process/repository outcomes are established. OS lock release is permission to inspect recovery, not permission to start a conflicting review. A dead host with a live/unknown child blocks mutations. Do not infer child lock inheritance: Windows explicitly distinguishes inherited handles from access to the parent's locked region.
6. Release only after queued work settles and external outcomes are known, then durably publish release before unlocking. Handoff needs the acknowledged token protocol. Stale callbacks cannot release another token. Two reclaimers serialize on the permanent guard; neither may advance the fence while earlier work remains uncertain.

This is a proof plan, not an approved or validated protocol. Initialization, publication failure, process death and handoff need explicit failure boundaries before production implementation.

## Remaining acceptance gates

All of #18's store/ownership acceptance criteria remain open. The checkpoint proves only the public readiness blocker and preserves the existing read-only package.

- Real simultaneous claims/first registration across profiles/copies and differing environment roots; one store or explicit recovery.
- Two reclaimers, orphan publication, delayed heartbeat, stale callbacks, handoff failure, PID reuse and dead host/live child; no overlapping effects or guard deletion.
- Independent control-file publication/flush failures, corruption, unsupported/newer protocols, network/redirected roots and store incarnation surviving database restore.
- Worker-only disk SQLite with verified WAL/FULL/foreign keys/secure deletion/busy bounds, durable acknowledgments, scoped identities, expected revisions, deduplication and fencing.
- Installed public readiness/open/release actions with production storage and real processes on all six minimum/current VS Code platform cells. No mock ownership flag counts as guard evidence.

## Run this checkpoint

`pnpm validate` checks formatting, types and all fast tests. `pnpm test:host` packages/installs the VSIX and checks the real public command, React handshake, worker and unchanged disposable repository. Use `CRW_VSCODE_VERSION=1.141.2 pnpm test:host` for the minimum host.

Install `dist/code-review-workbench.vsix`, open a trusted local repository and run **Code Review Workbench: Check Readiness**. Git/SQLite can pass while **Review ownership · Blocked** explains that an extension update is required. This is not evidence of cross-window exclusion or disk-store durability.

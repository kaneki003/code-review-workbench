# Shared-state ownership gate (#18)

Status: owner approved the native helper on 17 October 2026 in the implementation conversation. The helper's OS lock, process identity and filesystem checks are implemented. This is a working checkpoint for [Protect shared review state across windows](https://github.com/kaneki003/code-review-workbench/issues/18); durable recovery files and the shared store remain unfinished.

Readiness reports the **Packaged ownership helper** separately from **Review ownership · Blocked**. Review entry and private-state writes remain unavailable. Only a disposable guard folder is used; no canonical registry, private database or recovery record is created.

## Approved packaging change

The [technical design](../design/technical-design.md#processes-modules-and-public-boundaries) requires a concrete, proven guard before mutations. The [storage contract](../design/private-state-storage.md#one-active-review-and-operation-ownership) also requires independent recovery files with validated atomic publication and platform-specific durability. The initial readiness package used only JavaScript and Node built-ins; the approved helper extends that package.

The owner approved a small worker-loaded native bridge for Windows x64, Linux x64 and macOS arm64. It provides OS file locking, process-start identity and local-filesystem validation. Durable recovery-file publication is the next part to implement. Authoritative review data will remain in the selected built-in SQLite worker. There is no independent background service or end-user compiler/install step.

This amends the [packaging boundary](../design/extension-architecture.md#build-package-management-and-tests): `node-gyp` 13.1.0 builds the helper against Electron 43.7.7 headers with Node-API 8. The VSIX includes the compiled helper and a worker probe. Packaging declares the actual OS/CPU target instead of advertising one binary as universal. No installation hook runs on users' machines. Approval authorizes this implementation; it does not establish the complete ownership protocol as safe or enable writes by itself.

Developers now need Python and a C++ compiler: Xcode Command Line Tools on macOS, a C++ toolchain/make on Linux, or Visual Studio C++ Build Tools on Windows. `pnpm build:native` builds only the helper; `pnpm test` and `pnpm build` build it automatically. Development headers are cached in a private OS-user temporary directory because gyp's Unix Makefiles cannot handle spaces in header include paths. Source checkout paths can contain spaces.

The build uses the [Node-API C interface](https://nodejs.org/download/release/v24.21.0/docs/api/n-api.html), with the [native build prerequisites](https://github.com/nodejs/node-gyp/blob/v13.1.0/README.md) and Electron's [Windows delay-load hook](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules#a-note-about-win_delay_load_hook). That hook lets the compiled helper resolve Node functions from the embedded host executable.

## Walk through the helper

1. `native/guard.cc`: `tryAcquire` validates a canonical local folder, opens a permanent guard file and asks the OS for a nonblocking exclusive lock. `release` closes only that handle; repeated release cannot affect a successor. Worker cleanup also closes outstanding handles. The guard pathname is never deleted as release/reclaim.
2. `processIdentity` reads Windows creation time, macOS `proc_pidinfo` recorded start time plus the fixed boot-session UUID, or Linux `/proc` start ticks plus boot ID. Missing processes and unknown/denied inspection remain distinct outcomes. `assertLocalDirectory` rejects redirects and limits initial filesystems to NTFS, APFS, ext4, XFS and Btrfs; this allowlist is a prerequisite, not durability proof for every filesystem.
3. `scripts/build-native.mjs`, `scripts/build.mjs`, `scripts/package.mjs`: compile, copy the binary/worker and create the OS/CPU-specific installer. The native API is used only in workers in production; real-process tests also load it directly to prove OS behavior.
4. `src/connections/native-probe-worker.ts` checks the helper in a temporary folder. `native-readiness.ts` reports failure without opening private data. `ReviewManager.checkReadiness` exposes the result while keeping full ownership blocked.
5. `tests/native-guard.test.ts` launches real competing processes and terminates processes/workers. `tests/native-readiness.test.ts` crosses the public manager boundary with the production worker/helper, including missing-binary refusal. Installed-host tests require the helper probe to pass from the actual VSIX outside the source tree.

## Evidence and alternatives

Inspected against the selected embedded Node 24.21.0 API/source on 17 October:

| Candidate                                                   | What it establishes                                       | Gap for this contract                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Atomic `mkdir` / exclusive file creation                    | One initial pathname creator                              | No proven token-safe release/reclaim. A reclaimer can inspect A, pause, then delete B's replacement guard. An orphan publication is uncertain.                                                                                                                                       |
| Heartbeat / PID existence                                   | A recent callback or a currently existing PID             | A delayed owner can still run. PID reuse needs OS process-start evidence; host death does not settle a child.                                                                                                                                                                        |
| SQLite ownership row                                        | Transactional row updates                                 | Not exclusion across a later external Git effect.                                                                                                                                                                                                                                    |
| Separate SQLite connection holding an exclusive transaction | Real SQLite filesystem locking while the connection lives | A viable candidate for exclusion, but connection death releases protection while an external child may survive. It still needs durable outstanding-operation records and identity/reconciliation. It does not implement the accepted independent recovery-file publication protocol. |
| Native bridge in the worker                                 | Direct OS access; lock/process primitives implemented     | Full owner/recovery protocol and supported-platform proof remain outstanding.                                                                                                                                                                                                        |

Node's [filesystem API](https://nodejs.org/download/release/v24.21.0/docs/api/fs.html) exposes exclusive creation, rename and synchronization, but no direct `flock`/`LockFileEx` interface. Its [process API](https://nodejs.org/download/release/v24.21.0/docs/api/process.html#processkillpid-signal) documents signal zero as an existence check, not start identity. This is an API inventory, not a claim that every possible built-in-only protocol is impossible.

The pinned [Windows libuv implementation](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/fs.c) uses `MoveFileExW` with replacement for rename and `FlushFileBuffers` for file sync. Node rename has no write-through option. Microsoft's [MoveFileEx flags](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) distinguish write-through behavior. These facts do not prove that adding a flag alone durably publishes a same-volume rename; the Windows file/directory durability protocol still needs validation. A successful temporary-file flush followed by rename is insufficient evidence by itself.

On macOS, the pinned [Unix libuv implementation](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/unix/fs.c) already attempts full synchronization with fallback. That is useful evidence, but it does not prove every filesystem or the complete recovery-file publication protocol.

[SQLite locking](https://sqlite.org/lockingv3.html) protects database access; it does not make database transactions atomic with Git effects. Moving control records into another SQLite database would change the accepted file protocol and still require crash/child/identity proof. It is an alternative decision, not an implemented fallback. Unbundled OS commands would introduce their own availability and packaging prerequisites.

## Full ownership protocol still to prove

1. Resolve the fixed rendezvous from `os.userInfo().homedir`. Validate the rendezvous and registered root as supported local filesystems. Acquire an OS lock on a permanent guard file there before registration or maintenance. Never unlink/replace the guard file as release or reclaim. Missing/malformed existing control records require recovery.
2. Under that lock, discover/register exactly one store. Publish a versioned control record durably before acknowledging a claim: random owner token, OS-verified host process/start identity, store identity/incarnation, increasing fencing generation and window location. Account changes cannot create a second owner. Readers see location and status only.
3. The helper uses nonblocking exclusive `flock` on POSIX and `LockFileEx` on Windows. [Linux lock lifetime](https://man7.org/linux/man-pages/man2/flock.2.html) and [Windows lock lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) differ; test each platform. Windows [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) supplies creation-time evidence. Combine these primitives with durable owner metadata before treating them as application ownership.
4. Serialize canonical worktree/common-Git-directory scopes in a stable order. Revalidate token/incarnation/fence and expected repository facts before external effects. Commit both database intent and independent recovery facts before dispatch. Transactional fencing, expected revisions and request deduplication stay in the worker.
5. Treat every interrupted dispatch as unresolved until actual process/repository outcomes are established. OS lock release is permission to inspect recovery, not permission to start a conflicting review. A dead host with a live/unknown child blocks mutations. Do not infer child lock inheritance: Windows explicitly distinguishes inherited handles from access to the parent's locked region.
6. Release only after queued work settles and external outcomes are known, then durably publish release before unlocking. Handoff needs the acknowledged token protocol. Stale callbacks cannot release another token. Two reclaimers serialize on the permanent guard; neither may advance the fence while earlier work remains uncertain.

The primitive is implemented; this full protocol remains a proof plan. Initialization, publication failure, process death and handoff need explicit failure boundaries. In particular, an OS lock becoming available after death does not prove a Git child stopped. No normal mutation path is enabled by the helper probe.

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

See the [checkpoint's test evidence and automated review](shared-state-validation.md).

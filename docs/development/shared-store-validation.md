# Shared-store validation (#18)

The canonical store, ownership guard, typed Git operation and explicit recovery are implemented. Review entry/content, checkout and stash remain later tickets. [Walkthrough](shared-state-ownership.md).

## Evidence

Tests use the public ReviewManager, production worker, real processes/filesystems and installed VSIX. Ownership is not replaced with a mocked flag; committed outcomes are checked through public receipts and Git, not SQL-row assertions.

- Competing windows/processes find one OS-user store across different HOME/data variables. Concurrent first registration produces one owner or explicit recovery; uncertain publication never creates a second store.
- Two reclaimers, dead hosts, live hosts with dead workers, old heartbeats, stale callbacks, deduplicated requests, failed/named handoff and stable account scopes exercise actual exclusion.
- A reserved app ref uses exact repository scopes, HEAD/index/file facts and ref/reflog path identities. Changed facts, redirects, shared reflog links, hooks, arbitrary targets and unchanged updates cannot authorize an effect.
- Prepared children cannot execute before the durable armed record. POSIX checks the recorded process and group; Windows uses a suspended process in a named no-breakaway job. A real Git child waiting behind a fixture-owned lock exercises host death and settlement.
- Independent observed receipts precede database projections. Lost acknowledgment and 38 injected failures cover record publication, pending barriers, actual SQL rollback, commit/ack ordering and dispatch. Native write/flush/rename/final-durability failures never produce false acknowledgment. Recovery observes applied/not-applied without replay; reflog checks prove at most one effect.
- Same-owner and dead-owner recovery, receipt account isolation, a restored old database, newer schema/protocol, corruption and unknown legacy intent exercise refusal/preservation. Unknown work stays blocked.
- Native tests include closed host standard descriptors, private directory publication, OS lock lifetime, process-start identity, replaced guards and redirected paths.
- Four installed-VSIX tests load the actual packaged worker/helper, preserve the repository during readiness, execute/read a typed receipt, hand off/reopen, recover after a separate host dies, and cancel a superseded webview attachment. All storage fixtures use isolated homes.

Local `pnpm validate` passed formatting, types and **100 tests** on macOS 25.6.0 arm64, developer Node 24.22.0. Local `pnpm test:host` also passed all four installed tests at VS Code 1.142.0 / embedded Node 24.21.0, Electron 43.7.7 and SQLite 3.53.4. At code commit `6c91fce`, [all six CI cells passed](https://github.com/kaneki003/code-review-workbench/actions/runs/39045663277): Windows x64, Linux x64 and macOS arm64 at VS Code 1.141.2/1.142.0. Each passed formatting, types, behavior tests and four installed-VSIX tests. macOS passed 100 behavior tests; Linux passed 99 with the macOS-only identity check skipped; Windows passed 98 with that check and the POSIX closed-descriptor test skipped. [Measured runtimes and VSIX targets](shared-store-platforms.json) are extracted from the six uploaded evidence files, package manifests and successful job logs.

The checks exercise real file publication, injected I/O failures and process crashes. They do not simulate hardware power loss or certify every volume. Installed Linux initially trapped on Chromium's copied file-descriptor ownership table; child-only kernel closes fix it and both installed host versions then passed. Windows installed tests exposed drive-letter case differences; workspace validation now checks actual directory identity, with a regression that also rejects a different folder. The initial Windows native run also caught default administrator-token object ownership; creation explicitly sets the actual user SID and protected DACL.

## Standards

The final review found redirected ref/reflog paths and ambiguous unchanged-reference receipts. Both are fixed: canonical path/link checks and recorded path identities guard start/settlement; unchanged updates are refused before intent. The reviewer confirmed **0 remaining documented-standard violations**.

One optional Speculative Generality judgment remains: the host-only legacy `recordRepositoryIntent` creation API is retained with its old unknown-work fixtures. It cannot execute Git or automatically clear its barrier. New operations use the typed API. This is a cleanup opportunity, not an ownership bypass.

## Spec

The final review found same-owner recovery using the caller's old revision after internal reconciliation. The caller is now validated first and the reconciled lease authorizes release. The public regression test passes. The reviewer confirmed **0 additional actionable findings**.

Earlier generic-command, descendant-settlement, publication-order and scope findings were addressed before this final review. The full review compares against main `69e9ab2c3ef25fc47cbfecf1878bbd235e35c768`.

Standards: 2 required findings fixed, 0 open violations, 1 optional cleanup. Spec: 1 finding fixed, 0 open findings. The draft PR stays unmerged and #18 stays open for the owner's review.

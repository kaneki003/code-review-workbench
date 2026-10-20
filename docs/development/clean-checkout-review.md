# Clean-checkout implementation review

Reviewed against freshly fetched `origin/main`, pinned at `91c7abd44c225119ff243a5cab3e63eda4593135`, as selected by the owner. Standards and spec reviews ran in separate agents, first at the guarded-Git checkpoint and then across the full [issue #22](https://github.com/kaneki003/code-review-workbench/issues/22) implementation through `ea1717c`, with focused follow-up review of the corrections below. The [walkthrough](clean-checkout.md) describes the final feature.

## Standards

No documented-standard breaches were found. The reviewers checked repository instructions, glossary, relevant ADRs and accepted architecture, Git/source and storage contracts. No additional `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists.

The full review found a P2 correctness hazard: completed-state Exit/recovery returned immediately after an interruption between durable completion and artifact cleanup. Git and editors were restored, but recovery never retried cleanup. Both paths now use the shared cleanup operation. Real-worker crash regressions assert removal of the owned original pin through both Recover and repeated Exit, with unchanged HEAD reflog proving checkout was not repeated. The reviewer confirmed the fix.

Two judgement calls were also resolved: execution/recovery now share repository-identity comparisons, and native editor activation/restoration share one group-focus command mapping and observed-state wait.

**Final Standards: zero remaining findings.**

## Spec

The checkpoint review exposed two safety defects that were corrected before the full implementation:

1. **Cached Git status could miss edits.** With `core.trustctime=false`, `core.checkstat=minimal` and a same-size/same-mtime edit, status could be empty before checkout overwrote the edited file. `0e89fe4` adds independent content/type/mode verification against index blobs, with stable repository facts around the check. The regression reproduces empty status and verifies refusal while retaining the edited bytes. Transformed working-file representations are conservatively refused at this checkpoint.
2. **An original detached commit could become unreachable.** A recorded object ID alone does not keep Git objects alive. `ca8bcff` pins the original commit through a separately journaled guarded reference update before preparing checkout. The regression creates otherwise-unreachable detached user work, expires reflogs, prunes unreachable objects and verifies exact restoration.

The checkpoint follow-up also caught an availability edge: creating the pin can create an initially missing reflog directory. `7afae0f` binds checkout intent to verified post-pin reference paths, with a regression for a repository without a reflog directory.

The final review found no missing requirements, incorrect implemented behavior or scope creep. It traced clean Enter/read/Exit, independent intent and database projection, protected checkout, original branch/detached restoration, native editor restoration, process settlement, repository-scoped startup recovery and conservative cleanup.

Self-review then tightened an ambiguous manual-switch outcome: Continue no longer completes Exit when an Active review has unexpectedly returned to its original checkout. It preserves Active recovery and requires explicit Restore. The public-manager regression verifies no implicit editor restoration and no repeated checkout; the spec reviewer confirmed the change.

Final matrix validation exposed a macOS process-group race. An isolated [CI reproduction](https://github.com/kaneki003/code-review-workbench/actions/runs/39138689815) captured `CHILD_UNKNOWN` during recovery; an exiting-group harness then reproduced `EPERM` locally. [Apple's `killpg1` implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c#L1612) can return that result while a group has no signalable member. Both native polling and recovery now treat permission denial as **not settled**; only verified absence clears the barrier. The public-manager regression accepts only that specific blocked recovery while retrying, verifies retained pending state and unchanged HEAD history on each attempt, and still requires completion within five seconds. Both reviewers confirmed the fix preserves safety.

**Final Spec: zero remaining findings.** Required platform validation is tracked separately from static review and must be green in the draft PR checks before acceptance.

## Validation

The real-Git fixtures use the production SQLite worker and native guard. Installed-host fixtures exercise actual save behavior, text/diff/overview tab state, pinned tabs, reversed multiple selections, vertical position and owner recreation. See the [walkthrough's verification commands](clean-checkout.md#verification) and [draft PR #34](https://github.com/kaneki003/code-review-workbench/pull/34) for the exact final test counts and Windows x64, Linux x64 and macOS arm64 minimum/current VS Code matrix.

Final local formatting/typechecking and all **168 tests across nine files** pass on macOS arm64 with developer Node 24.22.0 and Git 2.56.0. The installed minimum (VS Code 1.141.2) and current (1.142.0, embedded Node 24.21.0 / Electron 43.7.7) hosts each pass all six cases. A final host run exposed an immediate-focus assertion in the existing absent-diff-side fixture; the fixture now also checks the returned navigation anchor and observes actual native focus with its existing five-second bound. Follow-up Standards review confirmed that no behavioral assertion was removed or weakened.

Windows stable also exceeded earlier whole-scenario test deadlines in multi-step Git/SQLite fixtures. The Windows integration and compound installed-host cases now allow 120 and 180 seconds respectively. Git execution and native focus deadlines remain unchanged. Restoration preparation now shares entry preparation's bounded 45-second client acknowledgement allowance instead of the default ten seconds; timeout uncertainty and recovery barriers are unchanged. Review confirmed these changes.

### PR #34 scroll-restoration failure

In [run 39226545686](https://github.com/kaneki003/code-review-workbench/actions/runs/39226545686), five matrix cells passed. Windows stable reached editor restoration but returned recovery with “The saved editor scroll position did not restore.” The failed assertion expected completed Exit. Git restoration had already progressed to the native editor step.

The native adapter gave asynchronous `revealRange` requests three 30 ms waits. It also calculated each correction from the saved line instead of retaining the previous requested line. Native `AtTop` includes surrounding lines, so restoration needs an observed viewport update before calculating the correction. Slow delivery could consume all three attempts or produce a correction from stale state.

`editor-scroll.ts` now waits for a stable exact top line within the existing five-second native-state allowance. It retains corrections and waits for an observed viewport change before sending another target. An unchanged viewport cannot prove whether a reveal was a no-op or remains pending, so that ambiguity times out in recovery. The initial request accounts for the current displacement to handle native surrounding-line offsets. No completion assertion or recovery barrier was removed.

The focused host regression runs the production scroll routine against a real native editor, delaying reveal delivery by 150, 450 and 1,200 ms. The 150 ms case failed with the original scroll error before the fix. All delays now restore the exact saved line and leave no later viewport movement. It also covers starting at the native offset result itself. A permanently unchanged viewport still refuses restoration. The six original installed-VSIX cases also pass locally on VS Code 1.142.0. Cross-platform confirmation comes from the PR's checks after this fix is pushed.

### Earlier Windows validation (historical)

Both Linux and both macOS minimum/current cells pass in [run 39139619574](https://github.com/kaneki003/code-review-workbench/actions/runs/39139619574). Its Windows stable cell failed before checkout with a storage-connection failure; its minimum-version cell returned recovery during Exit. The final fixture assertions expose the overview prerequisite and actual Exit result instead of hiding the earlier failure. The acknowledgement-budget alignment has not been established as the cause or a verified fix for those Windows results.

[New diagnostic jobs](https://github.com/kaneki003/code-review-workbench/actions/runs/39141712137) were refused before starting because GitHub reported failed account payments or a spending limit. At that handoff, the owner chose **finish local work; leave CI blocked**, and Windows acceptance was incomplete. Actions later resumed for the run described above. No merge or issue closure is authorized by local results.

To run the full matrix against the feature branch:

```sh
gh workflow run check.yml --repo kaneki003/code-review-workbench --ref feat/22-clean-pr-checkout
```

Review totals: Standards — zero remaining findings (one P2 and two judgement calls resolved); Spec — zero remaining findings (checkpoint safety defects and availability edge resolved). Neither axis substitutes for execution-based evidence.

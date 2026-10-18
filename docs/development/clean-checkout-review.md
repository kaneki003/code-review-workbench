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

**Final Spec: zero remaining findings.** Required platform validation is tracked separately from static review and must be green in the draft PR checks before acceptance.

## Validation

The real-Git fixtures use the production SQLite worker and native guard. Installed-host fixtures exercise actual save behavior, text/diff/overview tab state, pinned tabs, reversed multiple selections, vertical position and owner recreation. See the [walkthrough's verification commands](clean-checkout.md#verification) and [draft PR #34](https://github.com/kaneki003/code-review-workbench/pull/34) for the exact final test counts and Windows x64, Linux x64 and macOS arm64 minimum/current VS Code matrix.

Final local formatting/typechecking and all **168 tests across nine files** pass on macOS arm64 with developer Node 24.22.0 and Git 2.56.0. The installed minimum (VS Code 1.141.2) and current (1.142.0, embedded Node 24.21.0 / Electron 43.7.7) hosts each pass all six cases. A final host run exposed an immediate-focus assertion in the existing absent-diff-side fixture; the fixture now also checks the returned navigation anchor and observes actual native focus with its existing five-second bound. Follow-up Standards review confirmed that no behavioral assertion was removed or weakened.

Review totals: Standards — zero remaining findings (one P2 and two judgement calls resolved); Spec — zero remaining findings (checkpoint safety defects and availability edge resolved). Neither axis substitutes for execution-based evidence.

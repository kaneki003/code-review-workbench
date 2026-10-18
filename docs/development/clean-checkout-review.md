# Clean-checkout foundation review

Reviewed against freshly fetched `origin/main`, pinned at `91c7abd44c225119ff243a5cab3e63eda4593135`, as selected by the owner. Standards and spec reviews ran in separate agents. This is the [documented working checkpoint](clean-checkout.md), not completion of [issue #22](https://github.com/kaneki003/code-review-workbench/issues/22).

## Standards

No documented-standard breaches were found. The initial review raised one judgement call: execution and recovery duplicated the same repository-identity comparisons. Both paths now use `RepositoryOperation.sameRepositoryIdentity`. Follow-up review found no remaining documented-standard breaches or baseline smells.

The reviewers checked the repository instructions, glossary, relevant ADRs and accepted architecture, Git/source and storage contracts. They found no additional `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

## Spec

The initial review found two implemented safety defects:

1. **Cached Git status could miss edits.** With `core.trustctime=false`, `core.checkstat=minimal` and a same-size/same-mtime edit, status could be empty before checkout overwrote the edited file. `0e89fe4` adds independent content/type/mode verification against index blobs, with stable repository facts around the check. The regression reproduces empty status and verifies refusal while retaining the edited bytes. Transformed working-file representations are conservatively refused at this checkpoint.
2. **An original detached commit could become unreachable.** A recorded object ID alone does not keep Git objects alive. `ca8bcff` pins the original commit through a separately journaled guarded reference update before preparing checkout. The regression creates otherwise-unreachable detached user work, expires reflogs, prunes unreachable objects and verifies exact restoration.

Follow-up review confirmed both fixes and found no further material defects or scope creep in the implemented foundation. It identified one nonblocking availability edge: creating the pin could create an initially missing reflog directory, making the later checkout refuse its own stale metadata snapshot. `7afae0f` binds checkout intent to the verified post-pin reference paths; a regression exercises a repository without a reflog directory.

The spec review explicitly retains the planned missing ticket work: native save/editor capture and restoration, Active/completion lifecycle, Enter/Exit/recovery UI, repository-scoped startup recovery, proven-owned cleanup and the complete failure/platform matrix. The checkpoint remains incomplete and unsuitable for merging as completed #22.

Final review status: **Standards — 0 remaining findings; Spec — no known defects in the implemented foundation, with the documented ticket omissions still outstanding.**

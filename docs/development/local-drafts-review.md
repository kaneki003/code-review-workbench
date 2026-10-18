# Local draft core checkpoint review

Reviewed the committed diff from `91c7abd44c225119ff243a5cab3e63eda4593135` through `22510ad` using separate Standards and Spec agents, followed by targeted review of `4cfd9f8`. The originating requirement is [Save and reopen anchored local drafts (#21)](https://github.com/kaneki003/code-review-workbench/issues/21), with the agreed manager testing seam in parent #16. This is the owner-requested working checkpoint before the writer UI; it does not complete #21.

## Standards

The first review found one P2 scaling concern. Every save rewrote all historical snapshots for that draft, including already-empty bodies. That conflicted with the storage contract's short-transaction requirement as typing history grew.

`4cfd9f8` resolved it. The original creation row now holds one authoritative current snapshot, addressed by its existing primary key. Each save/discard updates that one snapshot and inserts one body-free receipt. The source-intent registration lookup also uses its primary key. The original creation receipt remains unchanged on output because acknowledgments exclude the mutable snapshot.

The targeted recheck found no newly introduced concrete defect or documented-standard violation. No substantive baseline code smell was reported.

## Spec

No actionable correctness defect or scope creep was found in the completed durable core. The review checked exact target/account/copy scoping, expected revisions, duplicate/colliding requests, atomic rollback, deletion barriers and historical receipts. The targeted recheck confirmed that the revised snapshot layout preserves those guarantees.

Planned requirements remain outstanding: the accepted bottom writer, host-owned pending input and autosave cadence, the finite view/chunk protocol, Retry/Close/focus behavior, native draft discovery and view lifecycle, and React/installed-host/accessibility checks. They are listed in the [checkpoint walkthrough](local-drafts.md#remaining-work-in-21) and are not claimed as implemented.

Standards: one finding resolved, zero open. Spec: zero completed-core defects; the documented writer/integration work remains. Automated review does not establish installed-host behavior or another platform.

# Code Review Workbench

A continuing review of a selected code change, combining private investigation with deliberately chosen GitHub collaboration. These terms follow the approved [PRD](docs/product/PRD.md) and [current interaction contract](docs/design/figma-interaction-contract.md).

## Language

**Review context**:
The continuing understanding of one selected change, including its conversation, observations, decisions and relevant sources.
_Avoid_: Chat alone, proactive cross-PR memory

**Active review**:
The single review currently open in the workbench; other reviews can retain saved progress.

**Local committed review**:
A private investigation comparing two local commits or branches, without requiring a selected GitHub PR.

**Inspected source**:
The particular committed source version being reviewed. It can differ from the latest source available on GitHub; later edits enter review only after a commit and source Sync. A check against modified working files identifies those different inputs separately.
_Avoid_: Latest source when referring to retained older evidence

**Source Sync**:
A deliberate source update during an active review, or the automatic source synchronization required on entry or resume, with affected-state reconciliation.
_Avoid_: Discussion refresh

**Discussion refresh**:
An update to accessible GitHub conversation that is independent of source synchronization.

**Checkpoint**:
An optional, reorderable grouping of related changed files with a review purpose.
_Avoid_: Mandatory review stage

**Reviewed mark**:
A person's explicit indication that they reviewed a file, retained only while the applicable source remains unchanged.
_Avoid_: Visited, AI examined, approved

**Agent examination scope**:
The areas the assistant has and has not inspected, separate from human Reviewed marks and correctness claims.
_Avoid_: Review completion, clearance

**Investigation**:
The assistant's work to answer a question or offer review assistance within one review context.

**Investigation attempt**:
One try at an investigation, with its own inspected sources, partial answer and outcome. Retrying starts another attempt while retaining the original question.

**Workbench check**:
A focused command owned by the workbench to gather local evidence during an investigation. It is distinct from repository CI and commands the reviewer runs independently.

**Underlying concern**:
A single possible problem that can have several source locations, suggestions or discussion references.

**Companion suggestion**:
A private candidate concern with category, impact, evidence and limits, offered for the reviewer to inspect, dismiss or adopt.
_Avoid_: Published feedback, automatic review decision

**Local draft**:
Unfinished feedback retained on the current device at its original source or conversation target; it has not been sent to GitHub.
_Avoid_: GitHub pending review comment

**GitHub pending review**:
The signed-in reviewer's GitHub review record awaiting explicit submission, including comments already added to that record. It is the same record whether continued through GitHub or the workbench.
_Avoid_: Local draft, published review

**Published feedback**:
The exact chosen comment, reply or review whose publication GitHub has confirmed.
_Avoid_: Sent when delivery remains unconfirmed

**Delivery unconfirmed**:
A feedback action whose receipt has not been established; it requires receipt checking before an attempted resend.
_Avoid_: Failed, published

**GitHub delivery receipt**:
GitHub evidence establishing the confirmed result of a particular feedback or merge action. A confirmed queue entry establishes that a PR was queued, not that it merged.
_Avoid_: A sent request, matching text alone

**Queued merge**:
A PR accepted into the repository's merge queue whose eventual merge has not yet been confirmed.
_Avoid_: Merged

**Exit Review**:
The explicit action that ends the active review and restores the previous workspace, branch and unfinished work.
_Avoid_: Hide companion, submit review, merge

**Prior work**:
The workspace, source position and unfinished local changes present before entering a review, which Exit Review restores.

**Review-time changes**:
Local source changes made while a review is active, distinct from prior work and unfinished feedback.
_Avoid_: Local drafts when referring to source changes

**Personal review profile**:
One editable set of standing review instructions associated with a GitHub account and initially retained on the current device.
_Avoid_: Multiple selectable profiles, PR-specific decisions

**Private review state**:
The saved conversation, context, progress, suggestions, dismissals and unfinished local feedback for one review on the current device. It is distinct from repository work, the personal review profile and GitHub records.

**Review recovery record**:
The facts still needed to establish or safely complete an interrupted workspace transition or GitHub delivery. Any necessary remainder after private review state is cleared is identified separately to the reviewer.

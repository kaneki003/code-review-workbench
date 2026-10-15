# Code Review Workbench — Figma interaction contract

Read [the baseline index](README.md) for source precedence and evidence limits. The latest lifecycle decisions are recorded in [lifecycle-refinement.md](lifecycle-refinement.md).

Repository handoff updated 15 October 2026 with the centre, PR entry, Chat, and lifecycle refinements. This contract specifies the selected Stitch-based interface for an editable, connected Figma prototype. It is a design handoff, not a technical architecture or a native VS Code validation report.

**Accepted architecture/discussion amendment — 15 October 2026:** the [architecture decision](extension-architecture.md) retains ordinary code/diff tabs, inline reading, Context / Chat and the previously accepted Figma-styled bottom feedback composer. The owner also approved a PR discussion section in the existing ordinary Markdown overview for PR-level comments, submitted review summaries and threads whose source location is unavailable. Keep attribution, replies and original source information; Reply opens the existing bottom composer. This resolves the discussion destination without restoring the removed Review activity page. Other visual/focus requirements remain unchanged.

**Working file:** [Code Review Workbench, school account](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU). Actual frame links, interaction coverage and inspection results must be recorded after the designs are created and checked; this document does not claim that those steps are complete.

## Direction and boundaries

- Preserve the supplied left navigation and code-centred workspace. Checkpoints are optional; code remains accessible without completing a route.
- The right companion has **Context / Chat** tabs. Context is structured; Chat uses compact user messages, unboxed assistant prose and a bottom composer. Tab changes preserve both areas' state.
- Current collaborator discussion and **Companion** suggestions expand alongside their code anchors. A collapsed suggestion names its category, impact, short concern and line range. No repeated **Private** labels and no **Inspect evidence** button; inspectable source links remain inside explanations.
- Feedback writing uses an owned, autosaved inline composer beneath its source thread. Local drafts appear as tagged threads at their original anchors; Close retains their text. The right companion remains Context / Chat. Exact native host integration and durable typing behavior remain unverified.
- Publication is deliberately initiated through **Comment**, **Start a review**, **Add review comment** or **Submit review**. Companion prose is not implicitly added to GitHub.
- Native comment-widget styling, arbitrary opposite-side clickable gutters, sidebar sizing and continuous native inline-input autosave remain deferred host questions. Figma may illustrate them without establishing native feasibility.

## Shared fictional fixture

Use one coherent fixture across all prepared states: **acme/export-service · PR #248 · CSV exports**, branch `feature/background-exports` into `main`, inspected head **7e93a1**. The screenshots establish the visual reference, not verified repository behaviour or executed tests. These names, source snippets, people, counts and outcomes are fictional prototype data.

For the complete route, author six changed files. This expands the screenshot's compact sample; reconcile displayed totals rather than preserve contradictory numbers:

| Checkpoint | Changed files | Role |
| --- | --- | --- |
| 1 · Permissions | `src/api/export_policy.ts`, `src/api/export_policy.test.ts` | Establish requester/workspace access and the export key boundary. |
| 2 · Request lifecycle | `src/api/export_requests.ts` | Preserve request identity and deduplication before handing off a job. |
| 3 · Worker & output | `src/workers/worker.ts`, `src/workers/worker.test.ts`, `src/queue/export_queue.ts` | Consume/retry queued jobs, stream rows into CSV and upload the result with bounded memory and recovery. |

Checkpoint 3 is the main workspace entry. `worker.ts` has a collapsed Security/Minor suggestion about tenant-prefix alignment near line 49 and an expanded Performance/Major suggestion about potentially unbounded multipart upload concurrency near lines 76–81. Expanded content separates **Observation**, **Hypothesis**, **Source** and **Limit**. A source link to unchanged `src/storage/export_store.ts` opens related source, which is not counted as a changed file.

Two existing GitHub pending comments are restored initially: an API audit-identity comment and a worker recovery comment. **Pending count starts at 2**. Adopting the concurrency suggestion opens unfinished human text; **Add review comment** subsequently makes the count **3**. Explicit human Reviewed marks are fixture progress, separate from file visits, checkpoint selection, passing checks and AI analysis.

The latest sidebar refinement keeps six total files and three in Worker & output, as clarified by the builder. All-files Request and Queue states retain the full list. The three-dot workbench popup now contains Sync, Submit review, Exit review and draft discovery; the previous bottom action strip is superseded. Repository and PR selectors have anchored list popups and hover tooltips. Shared sidebar typography uses the supplied Inter / JetBrains Mono palette. See [sidebar-refinement.md](sidebar-refinement.md) and [figma-sidebar-checks.json](figma-sidebar-checks.json) for current evidence.

The new-commit branch uses head **9c24b6e**, where worker upload concurrency and its test change. Request/permission files remain unchanged. Previous suggestion, source links and draft anchors retain **7e93a1** until deliberately rechecked or retargeted. These prepared source transitions do not represent real commits.

## Interaction contract

### Navigation, context and return

**PR entry and overview — superseded on 15 October 2026.** Screen 01 adds/opens a PR outside the review list by URL. Existing PRs use the repository/PR dropdowns and automatically restore saved state; there is no Resume recent review action. Screen 02 is `PR-248-Overview.md` rendered in an ordinary editor tab. Its scope is PR identity and standard metadata, clearly labelled AI intent and summary, the original author Markdown description, six linked changed files with statistics, and three suggested checkpoints with purpose, context and grouped files. Worker & output groups three files. The separate Review activity page and its entry points are removed. Inline collaborator threads and the GitHub PR discussion link remain; the accepted architecture adds PR discussion to this overview for PR-level comments, submitted review summaries and unavailable-source threads. Missing status, commit count and description use user-authorized dummy fixture data. See [the latest refinement](pr-entry-overview-refinement.md).

Selecting a checkpoint filters its file list and opens its last visited file, or its first file on first visit. It updates the active code, checkpoint and file context together. It creates no human Reviewed mark. **Show all files** lifts the filter while retaining the selected checkpoint. Selecting another checkpoint's file in All files updates the displayed checkpoint relationship but keeps All files mode; explicitly selecting a checkpoint reapplies its filter.

Context uses the breadcrumb **PR #248 / Worker & output / worker.ts** and a stable section order: **File context**, **Checkpoint context**, **PR context**. The active file is initially expanded; the other sections show concise previews. File context presents **Changes**, **Fit in checkpoint** and **Relevant code**. Checkpoint context explains its purpose, relationship to neighbouring checkpoints and file membership. PR context explains intent and route relationships. Expansion preferences survive tab switching; content updates without hiding the current filename/revision.

Source links open ordinary source/diff tabs at the cited revision and range. Keep the initiating concern available through a tab or **Back to worker.ts** action. Return restores the original source location and expanded suggestion; it does not silently jump to the latest revision.

Inline collaborator threads, PR discussion in the ordinary Markdown overview and the GitHub PR discussion link provide discussion access; the separate Review activity page and its entry points remain removed. The overview includes PR-level comments, submitted review summaries and unavailable-source threads, with attribution, replies and original source information. Reply opens the existing bottom composer at the original PR/thread target. An inaccessible anchor retains its original revision and an explanation; it never invents a current line. Published discussion may refresh without source Sync. Loading failures or incomplete discussion remain visible; the GitHub collaboration decision defines fetching and reconciliation.

### Companion, discussion and writing

Clicking an inline header toggles its explanation and returns focus to that same header when collapsed. Collaborator threads retain author, timestamp, resolved state and original replies. Companion entries retain category/impact, source applicability and original read-only text. **Dismiss** immediately hides the suggestion and retains that visibility decision through navigation, with no reason prompt or placeholder. Related unchanged source does not automatically revive it.

**Ask companion** opens Chat with the selected concern/source in an attachment chip and a prepared question. It preserves previous conversation. Selecting another file updates available context but does not rewrite earlier messages or silently change an already-composed question's attachment. The attachment can be removed or deliberately replaced.

Chat states share the screen-12 conversation component. **Generating** progressively reveals assistant text through two timed partial snapshots, then the complete response. Stop replaces Send in the same composer position and retains the exact produced prefix. **Stopped** keeps the partial answer as a normal conversation state, restores Send, and offers Regenerate beside the response. **Error** preserves the conversation, question, source and partial answer, with compact error text and Retry near the affected response. Retry continues the response without duplicating the user message; the composer remains usable. This is a Figma prototype simulation, not per-token streaming. Manual navigation and GitHub actions remain available when AI is unavailable. Suggested checks are question prompts unless an action explicitly says it runs a command; no mocked green result is presented as an executed check. See [current chat refinements](chat-state-refinement.md).

**Use as feedback** expands editable human wording in the inline composer beneath the source card. The right companion retains Context / Chat. The header identifies file, range, source revision and, for replies, the original thread. Prepared text may be edited in the intended product; the Figma prototype demonstrates this through labelled before/after states. **Close** keeps unfinished text in the tagged local draft thread. Draft shortcuts return to that source anchor and reopen its composer. **Discard draft** explicitly removes it. Returning to another file never transfers that text to a different anchor.

| Visible state/action | Exact destination and inclusion |
| --- | --- |
| **Draft · saved on this device** | Unfinished comment/reply/summary. Nothing sent to GitHub; pending count unchanged. Include **Saving…** and **Could not save · Retry** variants. |
| **Comment** | Publishes only the exact visible comment/reply at the shown target. Use helper text **Publish this comment now**. General Chat and other suggestions remain excluded. |
| **Start a review** | Explicitly creates a GitHub pending review with this comment when none exists. It is not published feedback. |
| **Add review comment** | Explicitly adds this comment to the existing GitHub pending review. Initial 2 becomes 3 in the main journey. |
| **GitHub pending review** | A GitHub record awaiting submission. Review composer includes its comments; local unchecked text cannot remove those records. Editing/removal needs the appropriate explicit pending-comment action. |
| **Submit review** | Publishes the displayed pending comments, visible summary and deliberately selected Comment/Approve/Request changes decision. |
| **Published** | Brief confirmation inside the existing workspace with receipt/source context; clear only the appropriate submitted pending counts. The review remains open; exit is separate. |

### Freshness, submission and recovery

Active new commits show **New commits available · Reviewing 7e93a1** and **Sync**. Do not silently refresh the checkout, explanations or human marks. Entry/resume checks latest source before presenting a current-source claim. After Sync, preserve unaffected Reviewed marks, pending comments, unfinished typing and conversation. Clear marks on changed files and label affected explanations **Outdated · Based on 7e93a1** until rechecked. Keep original draft/pending anchors visible; reanchoring is deliberate.

If a workbench check is running, Sync offers **Wait** or **Stop check and sync**, preserving its interrupted/unknown outcome. This is a prepared state only; the prototype runs no commands.

**Submit review** opens a Finish review overlay containing pending comments, editable summary, inspected head and three radio choices. Decision starts unchosen; no AI severity selects it. Show unfinished text separately as **Not included yet · Open draft**. Published replies are not sent again. Approve and Request changes are unavailable while newer source is unsynced; Comment remains possible for accurate feedback on explicitly identified older source. No mandatory AI pass, test run or all-files completion gate.

Known failure preserves all text and offers Retry. **Delivery unconfirmed** first offers **Check receipt**; do not offer an unconditional resend that could duplicate feedback. Receipt branches to confirmed publication or a confirmed-unsent retry. Closing the overlay preserves the summary and decision. Successful submission returns to the workspace with a receipt and clears only successfully submitted pending state; it does not exit or merge.

Resume restores active PR/checkpoint/filter/file, expanded suggestion, selected companion tab, dismissal, drafts and pending review, with source freshness made explicit. **Exit review** restores prior workspace/branch/work. Show restoration progress, confirmed exit and a failure that keeps review/recovery context. Hiding the companion is never Exit.

## Seven screen families and state inventory

Reuse the same shell and component variants rather than create a new full screen for each state.

| Family | Required variants and key transitions |
| --- | --- |
| 1 · PR selection / entry | Add/open a PR absent from the list by URL. Existing reviews use repository/PR dropdowns and automatically restore saved state. Setup progress, access/setup failure, retry and local-reading fallback stay in their existing workflows. |
| 2 · PR overview | Ordinary Markdown editor preview with PR metadata, labelled AI intent/summary, author Markdown, six linked changed files and three checkpoint groups. PR discussion adds PR-level comments, submitted review summaries and unavailable-source threads; Reply opens the bottom composer. Inline collaborator threads and the GitHub discussion link remain. |
| 3 · Workspace | Context/Chat; checkpoint/all-files; selected file; collapsed/expanded thread and Companion entry; AI generating/partial/stopped/error; human Reviewed action; source-ahead and post-Sync outdated variants. |
| 4 · Related source | Unchanged helper/source at cited head; source revision and range; missing/access-failed state; return to original suggestion. |
| 5 · Feedback writing | Tagged anchored draft and inline composer; scoped comment and reply; draft saved/save-failed; zero/existing pending review; immediate Comment; pending added confirmation; Close/Discard. |
| 6 · Finish review | Exact pending contents, excluded draft, summary, explicit decision; Sync-first gate; known failure; uncertain/checking receipt; confirmed published. |
| 7 · Resume / exit | Restored work with freshness notice; restoration progress; confirmed exit; restoration failure and Retry/Return to review. |

Also inspect one narrow workspace, one companion-collapsed workspace and a light-theme example. These are adaptation probes, not measured native breakpoints. Merge, provider setup, attachments, profile editing and command grants remain requirements to carry forward; do not imply the seven-family journey implements every PRD feature. Add focused component variants where needed rather than expanding into architecture.

## Connected prototype journey

**Main start:** PR list → Open #248 → setup progress → PR overview → checkpoint 3 → worker.ts / Context → Show all files → permission file → checkpoint 3 (restores worker.ts) → expand concurrency suggestion → source link → return → Ask companion → Chat generating/response → Use as feedback → saved draft → Close → another file → reopen anchored draft composer → Add review comment (2 → 3 pending) → new commits notice → Sync → outdated suggestion → recheck current worker source → Submit review → Request changes → Submit → Delivery unconfirmed → Check receipt → confirmation inside the active workspace → Exit review → restoration progress → PR list/prior-work outcome.

**Short branches from the same families:** expand collaborator thread → Reply → Close/restored reply; immediate Comment; Start a review with no pending review; dismiss a suggestion; AI Stop/Error/Retry; known submit failure/Retry; inaccessible evidence; setup failure/local reading; source-ahead review gate; exit restoration failure/Return to review.

Use explicit prototype starting points for the main journey, new-commit recovery, submit failure and narrow reading so reviewers need not replay every step. Navigation/back behaviour must be wired, not merely described. Document any branch that remains an annotated design rather than a verified clickable transition.

## Accessibility and adaptation contract

- All actions have text or accessible names. Origin, impact, freshness, resolved state and Reviewed state never rely on colour, tiny icons or opposite-side placement alone.
- Define ordered focus through navigation, source locator, inline header/actions, Context/Chat tabs and composer. Keyboard commands should support checkpoint/file navigation and next/previous thread/suggestion. Actual native shortcuts remain unassigned until host conflicts are checked.
- Tabs use directional navigation; Enter/Space activates controls. Overlays place focus at the title/first appropriate field, retain a clear Close action, and return focus to their trigger. Escape closes an overlay/writer while preserving text; it never discards or publishes.
- Clicking Reply/Use as feedback moves focus into the scoped writing field. Closing returns to the source trigger. Opening a source link focuses its destination; Return restores the initiating line/control. New replies/results do not steal focus.
- Narrow layouts wrap tags/actions and allow independent code/companion scrolling. Put horizontal scrolling in code, not in navigation/context prose. Keep source revision, filename and submit/exit access reachable when the companion is hidden. Do not promise automatic sidebar width reclamation.
- Use host-aligned semantic tokens for editor/sidebar/panel surfaces, text, borders, focus, links, selected states, warnings and diff colours. Light/dark changes preserve hierarchy and contrast; reduced motion uses immediate transitions. Resizing/zoom must not clip controls or hide the publication destination.

## Simulation limits and checking

Figma prepared states simulate typed text, autosaving, streaming AI, local/GitHub records, source updates, receipts and restoration. They perform no real typing persistence, cloud call, command, checkout, GitHub publication or native-editor operation. Editable layers/components are not proof of interaction; actual supported transitions must be connected and walked through separately. Screen-reader, real keyboard editor behaviour and continuous resizing remain annotated intent when Figma cannot exercise them.

Expert check script: start without a route; orient to the PR; select checkpoint 3 and confirm only its files; locate its companion file context; expand a suggestion and identify observation versus hypothesis; follow and return from its source; adopt feedback and explain why pending is still 2; close/resume the draft; explicitly add it and verify pending becomes 3; reconcile new commits without losing text; identify excluded drafts in Finish review; recover uncertain delivery without duplicate send; exit without mistaking companion collapse for restoration. Repeat the code/context task at narrow width and light theme. Record observed clipping, missing returns, ambiguous controls and unsupported interactions; these are prototype checks, not user testing or measured productivity.

## Handoff to later technical work

Carry annotated frame links, component/state inventory, this contract, requirements coverage, source fixture, checked interaction paths and unresolved limitations into architecture. Deferred host checks should answer native inline reading/marker behaviour, owned-writer autosave and focus, source/diff navigation, movable views, theme/zoom and restoration recovery. Later architecture must decide storage/synchronization and account/provider mechanisms; this design document does not choose them. Figma completion can support those decisions without being treated as proof that native VS Code behaviour works.

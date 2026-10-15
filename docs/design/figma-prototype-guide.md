# Code Review Workbench — Figma prototype guide

This guide incorporates the [latest lifecycle refinement](lifecycle-refinement.md): anchored inline drafts, immediate dismissal, in-workspace publication confirmation, and removal of Review activity. For surviving destinations, use the [current lifecycle wiring](figma-lifecycle-rewired.json) and [state ledger](figma-lifecycle-state.json); older wiring ledgers are historical evidence.

Repository handoff updated 15 October 2026. The selected Stitch-based direction is now represented by editable Figma layers/components and saved prototype reactions in the school account's **Code review workbench** file. Structural and visual inspection results are recorded separately; this guide does not claim a completed click-through, keyboard test or native VS Code test.

[Open the main prototype](https://www.figma.com/proto/iUydEGUJkOMhggD3wMTFKU?node-id=6-2&starting-point-node-id=6%3A2) · [Open editable designs](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU)

The Figma page **00 Read me and interaction rules** contains the selected behavior, main walkthrough, focus/resizing intent, inspection results and remaining boundaries as editable text. [Open that in-file contract](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU?node-id=28-2364).

The fixture is **acme/export-service · PR #248 · CSV exports**. Source, people, conversations, findings, checks and GitHub outcomes are fictional. Initial inspected source is **7e93a1**; newer-source states use **9c24b6e**.

The latest shared sidebar replaces the bottom action strip with the three-dot workbench popup. Open that popup for Sync, Submit review, Exit review and draft discovery. Selectors open anchored repository/PR lists; their chevrons show hover tooltips. Changed Files counts six files overall, while Worker & output shows three. [View the current reusable examples](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU?node-id=41-2818).

## How to explore

Start with **Main review journey**. The saved interaction graph is intended to connect:

1. Add/open a PR by URL at entry, or select an existing PR from the approved repository/PR sidebar selectors. Setup advances on a timer to the Markdown PR overview. Existing selection restores a prepared workspace through the current lifecycle wiring.
2. Select **Worker & output**. Compare file, checkpoint and PR context in the companion; use **Show all files**, then return through a checkpoint. Checkpoint selection opens its prepared remembered/first file.
3. Expand the **Performance · Major** Companion suggestion in `worker.ts`. Follow its source link and return to the concern. Use **Ask companion** to enter Chat; the prepared AI response advances through loading on a timer. Stop/error/retry states are available through separate branches/flow starts.
4. Choose **Use as feedback** to expand the inline composer beneath the source card. The right companion stays Context / Chat. **Click the writing field** to show the prepared edited text; this is not a real editable text input. Close retains the tagged local draft. Draft shortcuts return to its original source anchor and reopen the composer.
5. Choose **Add review comment**. Pending increases from **2 to 3** only after this explicit action; opening or editing the draft does not add it to GitHub.
6. Explore the new-commit notice and **Sync**. Old evidence and draft anchors retain **7e93a1**; changed-file Reviewed marks and affected explanations are reconciled in prepared states. Follow the recheck path before finishing the review.
7. Open **Submit review**, inspect exact pending comments and the excluded unfinished-text cue, choose **Comment**, **Approve** or **Request changes**, and submit. New unsynced source gates Approve/Request changes. The summary field also uses a prepared edit transition.
8. The uncertain-delivery path offers **Check receipt** before a resend. Receipt checking advances on a timer to a prepared confirmed outcome. Confirmed publication briefly appears in the existing workspace and clears only the corresponding pending counts. It leaves the review active.
9. Choose **Exit review**. Restoration advances on a timer to the prepared prior-work/entry outcome. Hiding the companion is a separate action.

Timers simulate setup, AI response, receipt checking and exit restoration. They invoke no external service or command. Use Figma's restart control when returning to the starting fixture; prototype-variable changes within the presentation are not durable product storage.

## Eight flow starting points

Use the Figma prototype's flow selector to jump directly to:

| Flow | Entry and purpose |
| --- | --- |
| **Main review journey** | PR entry (`6:2`); follow the connected understanding-to-publication path. |
| **Inspect context and suggestions** | Worker workspace (`6:4`); inspect Context/Chat and inline suggestion/source returns. |
| **New commits and recovery** | Source-ahead state (`6:19`); inspect Sync, outdated evidence and review gates. |
| **Known submission failure** | Failed review outcome (`6:39`); inspect retained text and retry. |
| **AI error and retry** | Companion error (`6:15`); inspect question retention and recovery. |
| **Narrow writer** | Narrow workspace (`6:27`); inspect the prepared compact writing path. |
| **No pending review** | Start-review state (`6:44`); inspect the zero-pending alternative to Add review comment. |
| **Restoration failure** | Failed exit restoration (`6:42`); inspect Retry/Return to review rather than a false success. |

## Editable state inventory

The current design guide records **35 main prepared-state frames** and **16 overlays** after the lifecycle cleanup. The eight documented flow starting points below remain the handoff routes; live playback has not been verified. Twelve internal routing helpers implement binary return/review/file conditions; these are Figma helpers, not product screens or extension architecture. The original foundation’s 9 component families / 27 variants is extended with a shared Sidebar, SVG icons and three row families. Sidebar text uses the supplied **Inter / JetBrains Mono** palette and semantic **Dark / Light** modes. All-files Request and Queue states now preserve All-files navigation.

The earlier full-flow inspection passed **48 graph/structure checks**, including remembered-file navigation, source returns, retained edits, explicit pending addition, stale-source gates, uncertain delivery and exit. Its saved counts and screenshots are historical evidence. The earlier sidebar verification separately passed for 39 shared instances, 195 popup/tooltip bindings, correct scope/counts, expected fonts, valid saved destinations and editable vector/text layers. Filtered/all/light examples, wide/narrow/light workspaces and the anchored open menu were inspected. This is expert visual and saved-graph inspection; live player click-through, keyboard and native behavior are not claimed. The routing helpers still need live playback review.

The seven families are PR selection/entry; PR overview; Context/Chat workspace; related source; feedback writing; Finish review/publication recovery; and resume/exit. They share the workbench shell and component states. Narrow, companion-collapsed and light-theme examples are adaptation probes.

Use the historical [frame/control/flow ledger](figma-school-wiring.json) and [routing repair ledger](figma-school-route-repair.json) for node identifiers instead of a duplicate 54-item list. The [interaction contract](figma-interaction-contract.md) specifies intended behaviour and the boundaries between unfinished text, GitHub pending records and published feedback.

## Current interaction boundaries

- Repository/PR selection, model selection and attachments use one fixture; the prototype is not a general chooser or upload experience.
- Chat and expanded-context combinations for non-worker files are not linked. Use the worker flow to exercise those modes.
- Request/Queue All-files prepared states preserve the full file list, as recorded in the sidebar refinement. Arbitrary combinations still require live playback review.
- The collapsed **Security** entry is a reading illustration; expansion is not linked. The **Major** inline suggestion carries the connected inspection/adoption journey.
- Standalone setup/access failure, empty list, draft save failure, missing source and Start a review designs exist. Some do not branch from Main; inspect the canvas or the relevant separate flow rather than assume every screen is reachable through Main.
- Prepared field clicks demonstrate before/after wording, not free typing. Figma states demonstrate proposed draft retention, pending counts, source updates and receipts; they do not perform real persistence, GitHub publication, checkout or restoration.
- Fixed narrow/theme frames do not prove continuous resizing, zoom, screen-reader behaviour, focus restoration or native editor/comment interactions. Browser automation could not initialize successfully, so no actual click-through or keyboard validation is claimed here. Saved reaction metadata still needs to be distinguished from direct interaction checks.
- This is a scripted task prototype, not a general stateful application. Arbitrary combinations outside the main/linked branches can return to a prepared fixture state; use the contract for intended product behavior and record missing combinations before implementation.
- The exact source header, inline widget styling and Reviewed checkbox placement remain host illustrations. A native command/view contribution must establish their eventual placement; no custom native editor header is promised.

Native VS Code prototyping and the architecture/host feasibility work are deliberately deferred at the user's request.

## What to review before technical planning

Walk the connected task, then inspect the recovery starts. Check whether the active code, filtered files and context agree; whether source navigation has a clear return; whether Chat retains the original question and scope; whether adopting a suggestion is distinguishable from adding pending feedback; and whether Submit review shows exactly what will be published.

Pay particular attention to old-source anchors after Sync, excluded unfinished drafts, the receipt-before-retry path, and Exit versus companion collapse. At narrow width, inspect code readability, tag/action wrapping, overflow and access to submission/exit. Compare light/dark hierarchy and focus styling visually without treating those frames as accessibility certification.

Record broken/missing links, clipped text and ambiguous state language as prototype findings. The package supports design review and later implementation decisions; it is not user research, market validation or a demonstrated native extension.

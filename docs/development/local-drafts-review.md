# Local draft review and validation

Reviewed the issue #21 branch from merge-base `91c7abd44c225119ff243a5cab3e63eda4593135`. Separate Standards and Spec agents reviewed the durable checkpoint, then the complete writer/native continuation through `54bcc15`, followed by targeted rechecks of the corrections through `f6ab7ff`. The source is [Save and reopen anchored local drafts (#21)](https://github.com/kaneki003/code-review-workbench/issues/21), using parent #16's agreed public-manager, React and installed-host testing seams.

## Standards

**Zero open documented-standard findings; zero substantive smell findings.**

The checkpoint review found unbounded historical snapshot rewrites. `4cfd9f8` changed edits to update one authoritative snapshot by primary key and append one body-free receipt. Rechecks confirmed bounded per-edit work and unchanged duplicate-request guarantees.

The continuation review found three areas to correct:

- Account fencing must hide private presentation without destroying rejected browser input. Recovery now remains only in memory, keyed by the exact opaque original draft/review/content identity. Separate drafts survive repeated fencing, and an existing recovery copy takes precedence over older host-pending text for that same identity.
- A presentation-generation change must not erase the outcome of an actual commit. The manager now retains body-free save/discard receipts even when it blocks stale presentation.
- Component styling must follow the accepted Tailwind approach. Layout and state variants now use complete static utilities; CSS holds semantic VS Code theme aliases and deliberate base/focus rules in explicit layers.

A late Saved projection also used to clear a newer local validation error. Local errors now retain their Copy/Retry path until corrected or resubmitted. The final targeted Standards recheck confirmed the recovery-copy priority correction and reported no remaining finding.

## Spec

**Zero open findings; no scope creep found.**

The complete review found and resolved these behavioral races:

- Destination discovery could yield while the outgoing writer received more input. Opening now locks and flushes that latest input before replacement; a failed flush retains its original writer and Retry path.
- Rejected oversized input could rewind the local revision while older host projections were delayed. The client tracks its transmitted revision separately, retaining the latest trimmed text.
- Retrying a failed transport against an old snapshot could overwrite the newest visible text. Retry/Close now obtain an authoritative full reset before replaying the retained body. Older frames fall below that reset's sequence and cannot replace it.
- A successful Close could create a false recovery copy if its intermediate Saved projection was coalesced. Confirmed empty Close completion no longer does so. Conversely, switching writers while Close is still awaiting resynchronization preserves the original rejected input; an unsent Close is not treated as confirmation.
- A real commit receipt suppressed by account fencing left obsolete expected revisions. Preserving that receipt lets the original verified writer continue normally.
- Retry after failed Discard deleted storage but left the native thread's text. Native reconciliation now runs when the current writer clears, including this retry path.

The final Spec recheck confirmed the Close/switch guard and reported no open finding. Automated review does not establish visual parity or a complete human screen-reader session.

## Validation evidence

| Boundary                                 | Observed result                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm validate` at `9cca9ad`             | Formatting, types and all 169 tests across 10 files passed on macOS arm64, Node 24.22.0, Git 2.56.0.                                                                                                                                                                                                                                                                                                                      |
| Final React file after transition guards | All 11 cases passed against the real manager/worker, including delayed projections, failed transport, repeated account fences and Close during resynchronization. This adds one regression to the preceding full-suite count.                                                                                                                                                                                             |
| Installed stable VS Code 1.142.0         | Six host cases passed, including actual Chromium typing, real failed save/Retry, Close focus return, original-target native discovery, recreation, moving, hidden autosave, deletion and failed-Discard retry cleanup.                                                                                                                                                                                                    |
| Installed minimum VS Code 1.141.2        | Six host cases passed after the final recovery guards and visibility-aware browser harness.                                                                                                                                                                                                                                                                                                                               |
| Accessibility/layout                     | Browser accessibility names for textbox/Close/Discard, real Escape input, original selection focus, dark/light/high-contrast themes, zoom, narrow wrapping and keyboard reveal of the short-panel footer were checked. Review screenshots were inspected.                                                                                                                                                                 |
| Platform gates                           | The [CI workflow](../../.github/workflows/check.yml) runs fast tests and separately installed VSIX checks on Windows x64, Linux x64 and macOS arm64, each at the minimum and current stable VS Code. Consult the [draft PR checks and artifacts](https://github.com/kaneki003/code-review-workbench/pull/35/checks) for exact commits and outcomes. Each cell uploads `evidence.json`, the VSIX and `draft-writer-*.png`. |

The browser endpoint is enabled only by the disposable test runner and binds to loopback. Production views have no network connection permission. Native Git/source fixtures and manager tests verify drafting without source changes, GitHub mutations or AI requests. Failure cases exercise actual SQLite contention, read-only mode, full allocation and commit rollback through public actions.

One narrow-layout run failed during emulation despite a narrow workbench screenshot. The browser harness now explicitly excludes hidden documents and zero-width owning frames, and the minimum-host workflow passed; this does not establish the original failure cause. Linux startup screenshots then established a competing native Comments-panel transition while the writer awaited readiness. A reveal inside its hide event could lose to that same transition. The bounded explicit-open loop now reveals again on a later host turn. The installed regression explicitly opens Comments during writer startup; all six local stable host cases passed with that trigger. A Windows React assertion also exceeded RTL’s one-second default while awaiting an actual SQLite acknowledgment. That file now allows ten seconds on Windows for its real-storage interactions; the manager scheduling tests still check the original deadlines. Earlier failed runs are not counted as platform support; the latest CI checks remain the platform gate.

The editable Figma file was unavailable in this environment. Styling follows the checked-in hierarchy and written contract; exact Figma comparison remains owner review. Accessibility-tree checks do not replace manual VoiceOver/NVDA use. These fixtures do not establish power-loss/device durability or full automatic active-review resume. The [walkthrough](local-drafts.md) describes user behavior and recovery limits.

## 19 October CI root cause: native probe cleanup

The [run at `083590e`](https://github.com/kaneki003/code-review-workbench/actions/runs/39221345867) failed only on Windows stable: its initial readiness report blocked the native helper, while the draft-writing host scenario passed. The old report collapsed timeout, loading and filesystem failures into the same reinstall guidance.

Stage diagnostics in `d52bed8` reproduced that readiness failure on [Windows minimum](https://github.com/kaneki003/code-review-workbench/actions/runs/39224424042/job/117967138240): `timed out after five seconds; stage: cleanup`. The worker enters cleanup only after every native check and both guard releases succeed. One five-second window covered startup, verification and disposable-directory removal, so their combined latency could incorrectly report a broken helper on Windows.

Native verification retains its five-second window. Entering cleanup now grants one separate five-second window, giving a total acknowledgment budget of at most ten seconds. Repeated progress cannot extend it. Success still requires the final acknowledgment after file removal; stalled or failed cleanup remains blocked and directs the user to check again.

The focused regression runs the real helper and file removal with one second of startup and 4.5 seconds of cleanup latency. It failed before the correction with `blocked` after five seconds, then passed after the correction. A separate unresponsive-cleanup worker keeps sending progress and still times out without success. Five focused native-readiness cases pass, including error-code reporting without raw worker text. The [PR checks](https://github.com/kaneki003/code-review-workbench/pull/35/checks) track the corrective matrix run. The separately reported typing-focus issue remains deferred.

The first corrective matrix passed the new cleanup cases on Windows stable and the complete Windows minimum host. It also caught a diagnostic ordering race: an uncaught worker error could reach the host before its queued phase message. Failures now settle on worker exit, after collecting those messages, while retaining the error code and rejecting success after an observed error. [Node's worker-message contract](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#event-message_1) guarantees queued messages before exit. The real-worker regression repeats the immediate progress/throw sequence twenty times and continues checking the exact phase, code and absence of raw worker text.

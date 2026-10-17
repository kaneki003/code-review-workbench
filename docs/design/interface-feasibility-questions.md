# Interface decisions and questions for later architecture

Architecture is now selected in the [accepted extension contract](extension-architecture.md). It fixes native/owned surfaces, state ownership, local desktop support, pnpm/build/test/version constraints and the overview destination for PR-wide/unanchored discussion. The checks below remain implementation acceptance obligations; this planning decision does not claim they have passed.

The [accepted Git/source lifecycle](git-source-lifecycle.md) selects existing-folder stash/checkout/restoration, repository-scoped recovery, exact committed-source identities, local committed comparisons and Sync reconciliation. The owner's 16 October amendment removes review of uncommitted work and its private source-snapshot capture. The [accepted private-state storage](private-state-storage.md) selects the shared SQLite/worker store, ordered saving, ownership, backup/migration and clear/recovery rules. The [accepted GitHub contract](github-collaboration.md) supplies endpoint/account, discussion/pending-review, publication/reconciliation and merge/queue rules, with explicit provider-race limits. The [accepted interim AI contract](ai-investigation.md) selects direct personal-local ChatGPT-plan requests, host-owned tools/history, model switching and bounded recovery. Actual local authorization/inference, packaging and containment remain unverified; public ChatGPT/Gemini eligibility and release reconciliation remain pending. Their platform/provider fixtures remain implementation gates. Detailed local-to-later-PR linking is explicitly deferred to implementation by the owner.

Repository baseline: read [the current interaction contract](figma-interaction-contract.md). The [15 October native-host decision](https://github.com/kaneki003/code-review-workbench/issues/5#issuecomment-6190598100) accepts a bottom feedback composer with Figma styling/internal layout preserved and all other behavior unchanged. Earlier host research is dated 11–12 October 2026; the bounded experiment does not establish production implementation or full compatibility.

Prepared before direction selection, 11 October 2026. These are observable interface obligations and bounded host checks, not an architecture, framework selection or implementation schedule.

## Supported surface choices

- Ordinary source/diff tabs and source references remain central. PR/files/checkpoints can use native Tree Views and Quick Picks; rich investigation/composition can use limited themed webviews.
- Secondary Sidebar contribution is supported from VS Code 1.106. Users can relocate views. A default position cannot be treated as permanent geometry.
- Source references need an inspected revision and accurate return location. The extension should not imply it can insert arbitrary summary strips into native editor chrome; orientation belongs in its own view, with native commands/context actions for file operations.
- Native comments can represent anchored discussion and read-only private AI threads with text/Markdown labels and permitted actions; delivery, pending-review inclusion, access and receipt state remain GitHub concerns. They do not expose a separate clickable opposite-side gutter or arbitrary custom collapsed strips.
- Keep source-anchored inline reading and Context / Chat in the companion. The owner accepted moving the owned autosaved feedback composer to a bottom panel while preserving its Figma styling/internal layout. Native comment typing emitted generic internal-model document events in the experiment, but a stable thread/controller ownership mapping was not established; these events are not the chosen autosave contract. See the [accepted decision and native evidence](https://github.com/kaneki003/code-review-workbench/issues/5#issuecomment-6190598100). Production persistence and exact native visual/focus behavior remain to be established.
- Collapsing a view does not establish that width is reclaimed. Use deliberate reviewer controls; verify any host command the selected flow actually depends on.

## Small host checks, only where the selected direction needs them

1. **Placement/movement/resizing:** contribute minimal mocked navigation and assistant views; move them between Primary/Secondary Sidebar and Panel, hide/reveal them and constrain width. Establish what the extension can control and what belongs to the user. Do not assume automatic sidebar-width control.
2. **Source/evidence/focus:** open a mocked diff, a related source at a known revision and a return command. Verify native editor-group behavior, inline/side-by-side diffs, focus and keyboard return at wide/narrow sizes.
3. **Comments/anchors:** register mocked discussion and private AI controllers, including both on one line. Check native collapse/expand, controller-specific actions, current/older/invalid anchors, origin labels, split diff, native Comments view and keyboard focus. Compare native glyphs with an optional CodeLens text entry; do not promise an arbitrary opposite-side click lane or exact GitHub strip. Verify the owned composer retains typing through navigation/reload. A fake CommentController does not prove GitHub delivery.
4. **Theme/accessibility:** use actual theme/font variables, focus order, screen-reader labels, F6 boundaries, zoom and high-contrast behavior. Browser checks alone do not establish native accessibility.
5. **View recreation/restore:** hide and recreate a mocked view while a partial response or draft is present; verify independent state/focus restoration. This need not implement real AI, repository preservation or GitHub sync.

Documentation establishes the basic surfaces. The [bounded native spike report](https://github.com/kaneki003/code-review-workbench/blob/458c92b4bdbda91fd85906333cfe778316c22784/docs/research/wayfinder-native-host-prototype.md) records the checks already exercised, corrected setup errors and remaining gaps. Continue targeted checks for disputed behavior; do not treat that single-host experiment as completion of this checklist.

## Interface obligations architecture must support

| Interface behavior | Question to carry forward |
| --- | --- |
| Safe entry and explicit restore | How will source availability, preserved prior work, unsafe-switch reading fallback and partial restoration be reported without false success? What state survives opening another repository/window? |
| One active review and batch Sync | How will repository-level progress explain per-PR results, missing local clone and running active checks, while retaining one active review? |
| Continuing understanding | What review identity preserves relevant same-PR decisions, partial/error/cancelled activity, attachments and focus independently of a webview's lifecycle? |
| Evidence and source heads | How can citations retain the actual inspected source while latest GitHub head, checked-out source and evidence age differ? How will uncertain dependency impact be surfaced for rechecking? |
| Draft/pending/published boundary | Which state is local and which is GitHub's pending review? Submission includes pending GitHub records; excluding one requires an actual permitted pending-comment action, not a local checkbox illusion. |
| Automatically retained writing | How will the Figma-styled bottom composer report saving/saved/failure and retain the exact source or reply-thread anchor without turning typing, blur or navigation into a GitHub action? |
| Hierarchical context and route filtering | How will PR/checkpoint/file explanations retain their inspected source and scope, optional checkpoints restore last visited files, and changed-file membership stay separate from related unchanged evidence? |
| Inline findings and discussion | How will private read-only suggestions stay distinct from collaborator records in native widgets, same-line collisions and native Comments view? Validate the accepted overview PR discussion destination for PR-level comments, submitted review summaries and unavailable-source threads, with Reply opening the existing bottom composer. |
| Exact feedback and source anchors | How will accepted PR/file/range destinations, older anchors and suggested-change blocks be validated and displayed before submission? |
| Uncertain delivery | How can receipt be established before a resend, including duplicate-prevention limits and access/rate-limit failure? What exact input remains recoverable? |
| Independent discussion refresh | How are partial/paginated access, collaborator changes, resolved/outdated flags and source Sync kept distinct in the UI? |
| Optional checks | How are workbench-owned running checks, Stop, occupied user terminals, grants, local-versus-CI output and source applicability truthfully exposed? |
| AI connection/fallback | Which supported cloud access methods are feasible, with deliberate provider choice, meaningful failures and continued manual/GitHub paths? No subscription compatibility promise comes from these designs. |
| Private state clearing | How can local PR data be cleared while repository work, profile, external provider handling and GitHub pending/published records remain separate? |
| Merge | How will unknown eligibility, enabled methods, queue requests and GitHub-confirmed outcomes be distinguished independently of review submission/Exit? |

The chosen concept, accepted narrow behavior, exact evidence expansion and composer flow must be recorded after the checkpoint. They should guide the later architecture without prescribing storage, Git mechanisms, provider frameworks or implementation schedules here.

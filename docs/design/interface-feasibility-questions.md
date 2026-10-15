# Interface decisions and questions for later architecture

Architecture is now selected in the [accepted extension contract](extension-architecture.md). It fixes native/owned surfaces, state ownership, local desktop support, pnpm/build/test/version constraints and the overview destination for PR-wide/unanchored discussion. The checks below remain implementation acceptance obligations; this planning decision does not claim they have passed.

Repository baseline: read [the current interaction contract](figma-interaction-contract.md). Host research is dated 11–12 October 2026; native implementation and compatibility remain to be established.

Prepared before direction selection, 11 October 2026. These are observable interface obligations and bounded host checks, not an architecture, framework selection or implementation schedule.

## Supported surface choices

- Ordinary source/diff tabs and source references remain central. PR/files/checkpoints can use native Tree Views and Quick Picks; rich investigation/composition can use limited themed webviews.
- Secondary Sidebar contribution is supported from VS Code 1.106. Users can relocate views. A default position cannot be treated as permanent geometry.
- Source references need an inspected revision and accurate return location. The extension should not imply it can insert arbitrary summary strips into native editor chrome; orientation belongs in its own view, with native commands/context actions for file operations.
- Native comments can represent anchored discussion and read-only private AI threads with text/Markdown labels and permitted actions; delivery, pending-review inclusion, access and receipt state remain GitHub concerns. They do not expose a separate clickable opposite-side gutter or arbitrary custom collapsed strips.
- The selected design now illustrates inline reading with an owned autosaved inline composer beneath its source card, while Context / Chat remains in the companion. Exact native integration remains unverified. Stable native comment APIs do not expose a typing-change event, so durable unfinished-input autosave is not assumed. See [inline feasibility evidence](../research/inline-comments-feasibility.md), checked 12 October 2026.
- Collapsing a view does not establish that width is reclaimed. Use deliberate reviewer controls; verify any host command the selected flow actually depends on.

## Small host checks, only where the selected direction needs them

1. **Placement/movement/resizing:** contribute minimal mocked navigation and assistant views; move them between Primary/Secondary Sidebar and Panel, hide/reveal them and constrain width. Establish what the extension can control and what belongs to the user. Do not assume automatic sidebar-width control.
2. **Source/evidence/focus:** open a mocked diff, a related source at a known revision and a return command. Verify native editor-group behavior, inline/side-by-side diffs, focus and keyboard return at wide/narrow sizes.
3. **Comments/anchors:** register mocked discussion and private AI controllers, including both on one line. Check native collapse/expand, controller-specific actions, current/older/invalid anchors, origin labels, split diff, native Comments view and keyboard focus. Compare native glyphs with an optional CodeLens text entry; do not promise an arbitrary opposite-side click lane or exact GitHub strip. Verify the owned composer retains typing through navigation/reload. A fake CommentController does not prove GitHub delivery.
4. **Theme/accessibility:** use actual theme/font variables, focus order, screen-reader labels, F6 boundaries, zoom and high-contrast behavior. Browser checks alone do not establish native accessibility.
5. **View recreation/restore:** hide and recreate a mocked view while a partial response or draft is present; verify independent state/focus restoration. This need not implement real AI, repository preservation or GitHub sync.

Documentation already establishes the basic surfaces. Run a spike for a disputed behavior rather than building a full extension to prove a static layout. No host spike has yet been conducted.

## Interface obligations architecture must support

| Interface behavior | Question to carry forward |
| --- | --- |
| Safe entry and explicit restore | How will source availability, preserved prior work, unsafe-switch reading fallback and partial restoration be reported without false success? What state survives opening another repository/window? |
| One active review and batch Sync | How will repository-level progress explain per-PR results, missing local clone and running active checks, while retaining one active review? |
| Continuing understanding | What review identity preserves relevant same-PR decisions, partial/error/cancelled activity, attachments and focus independently of a webview's lifecycle? |
| Evidence and source heads | How can citations retain the actual inspected source while latest GitHub head, checked-out source and evidence age differ? How will uncertain dependency impact be surfaced for rechecking? |
| Draft/pending/published boundary | Which state is local and which is GitHub's pending review? Submission includes pending GitHub records; excluding one requires an actual permitted pending-comment action, not a local checkbox illusion. |
| Automatically retained writing | How will the owned inline composer report saving/saved/failure and retain the exact source or reply-thread anchor without turning typing, blur or navigation into a GitHub action? |
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

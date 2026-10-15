# VS Code host patterns and interface feasibility

Research checked 11 October 2026. Evidence below is official documentation or source code unless labeled design judgment. No real user testing or preference study was conducted in this workstream.

## Decisions that affect the concepts

1. Keep the native code/diff editor central. `vscode.diff` opens two resource URIs; `vscode.changes` opens a list of resource comparisons. Evidence can open as an ordinary source editor beside the diff. This supports code navigation without rebuilding editor behavior inside a webview. Source: [Built-in Commands](https://code.visualstudio.com/api/references/commands), page dated 7 October 2026.
2. A default assistant in the Secondary Sidebar is feasible with VS Code 1.106 or newer. The October 2025 release, published 12 November 2025, finalized `viewsContainers.secondarySidebar`. The UX Sidebars and Views pages still say direct contribution is unavailable; this guidance is stale on that capability. Source: [1.106 release notes](https://code.visualstudio.com/updates/v1_106#_view-containers-in-secondary-side-bar), confirmed by [current implementation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/viewsExtensionPoint.ts). Host compatibility should be an explicit later decision.
3. Views must work after users move, resize, hide, and restore them. The Secondary Sidebar is opposite the Primary Sidebar, which users can put on the right. VS Code retains layout across sessions. Panels can be moved to all four sides; views can be moved using keyboard commands. Do not hard-code “left means navigation/right means AI.” Source: [Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout), accessed 11 October 2026.
4. Prefer native Tree Views for PR/file/checkpoint lists and commands for actions; reserve webviews for rich assistant/evidence/composition content. Official guidance limits custom views and recommends a small coherent view container. Source: [Views UX](https://code.visualstudio.com/api/ux-guidelines/views), [Sidebars UX](https://code.visualstudio.com/api/ux-guidelines/sidebars), accessed 11 October 2026. Design judgment: dense prose and editable multi-item review composition justify a webview; ordinary file selection does not.
5. A bottom Panel is plausible for wide evidence or a review tray, but cannot be the only location of essential status: users routinely minimize it. Its content must reflow if moved into a narrow sidebar. Source: [Panel UX](https://code.visualstudio.com/api/ux-guidelines/panel), page dated 7 October 2026. Design judgment: keep PR identity, draft count, and freshness reachable when assistance is hidden.

## Official workflow baseline

The GitHub Pull Requests extension provides an Activity Bar entry, query-grouped PR list, Description editor, Review Mode, changed-file/commit tree, native diffs, and editor comments. Checkout enables local testing/navigation; Exit Review Mode returns to the previous branch. The Description is the review submission surface. Sources: [Work with GitHub in VS Code](https://code.visualstudio.com/docs/sourcecontrol/github), page dated 7 October 2026; [official extension README](https://github.com/microsoft/vscode-pull-request-github/blob/main/README.md), accessed 11 October 2026.

Task fit: a familiar baseline for PR entry, orientation, file navigation, discussion, and review completion. Limitation: the documented checkout workflow can disrupt current work; preserving branch/local-edit context requires explicit interface states. It does not prove that another extension can call internal GitHub extension behavior. No public integration architecture is assumed.

GitHub pending review comments are visible only to their author until submission. This is different from private investigation and local feedback drafts. Source: [GitHub review quickstart](https://docs.github.com/en/pull-requests/get-started/reviewing-pull-requests-quickstart), accessed 11 October 2026. Design judgment: show distinct plain-language states: Private investigation; Local draft; GitHub pending; Published. State badges need labels and destinations, not color alone.

## Relevant native interaction patterns

| Pattern and task | Why it fits | Limitation | Official reference |
|---|---|---|---|
| Tree View for PRs, changed files, checkpoints | Familiar disclosure, file icons, selection, keyboard navigation; welcome content and progress are supported | Poor surface for long explanations; custom card layouts need a webview | [Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view), accessed 11 Oct 2026 |
| Quick Pick for opening/switching a PR or jumping to a checkpoint | Fast filtering and keyboard entry; description/detail carry brief metadata | Unsuitable for long multistep setup or rich orientation | [Quick Picks UX](https://code.visualstudio.com/api/ux-guidelines/quick-picks), dated 7 Oct 2026 |
| Native inline comments and Comments Panel for existing discussion | Author, timestamp, Markdown, reply/edit actions; threads anchor to document/range and can collapse; file comments supported | The same visual treatment for private notes and public comments could confuse destinations; controller API is a surface, not GitHub delivery | [VS Code Comment APIs](https://code.visualstudio.com/api/references/vscode-api#CommentController), accessed 11 Oct 2026 |
| Contextual editor toolbar action | Visible near the code under review | Official UX recommends one icon plus overflow; cannot fit a dashboard of actions | [Editor Actions UX](https://code.visualstudio.com/api/ux-guidelines/editor-actions), accessed 11 Oct 2026 |
| A short global Status Bar item | Restore a review and display current PR/session state while panels are hidden | Very limited space; avoid competing items and decorative colors | [Status Bar UX](https://code.visualstudio.com/api/ux-guidelines/status-bar), dated 7 Oct 2026 |

## Accessibility, themes, and state preservation

Native workbench convention: Tab between controls, arrow keys within toolbar/tablist, F6/Shift+F6 between workbench parts. Webviews need particular attention at the host boundary. Native diff has F7/Shift+F7 navigation and an Accessible Diff Viewer; Accessible View supports comments and chat. Source: [Accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility), dated 7 October 2026.

Design judgment: give every essential action a command; keep a visible focus indicator; restore focus to the invoking finding/checkpoint after source inspection; announce progress/error changes without reading each token; never require hovering or dragging to complete review tasks. Test 200% zoom, narrow views, keyboard-only flow, and high contrast.

Webviews can use VS Code theme CSS variables and editor font variables, and adapt to screen-reader/reduced-motion classes. They are separate custom HTML contexts. `getState`/`setState` are the documented preferred lightweight UI state persistence method; retaining hidden webviews has high memory overhead. Source: [Webview API](https://code.visualstudio.com/api/extension-guides/webview), accessed 11 October 2026.

Design judgment: view visibility must not be the source of truth for durable review history or drafts. Recreating an assistant surface should restore its task context. Rich HTML increases implementation and accessibility work; reuse small semantic controls and theme tokens.

## UI kit maintenance

Do not recommend the Microsoft Webview UI Toolkit for a new build: the official sunset issue schedules package/repository deprecation and archival for 6 January 2025. Source: [Sunsetting the Webview UI Toolkit](https://github.com/microsoft/vscode-webview-ui-toolkit/issues/561), issue opened 2024; checked 11 October 2026. Recommendation: native APIs plus a small themed webview control set. No replacement framework is required to answer the interface questions now.

## Public images available for direct inspection

Official documentation exposes these screenshot assets:

- [PR list](https://code.visualstudio.com/assets/docs/sourcecontrol/github/pull-request-view.png)
- [PR Description/editor](https://code.visualstudio.com/assets/docs/sourcecontrol/github/pull-request-description-editor.png)
- [Changed files and commits](https://code.visualstudio.com/assets/docs/sourcecontrol/github/changes-view.png)

These URLs were located and verified as official image resources. In this workstream the images were not visually rendered, so findings about their exact visual arrangement must be labeled documentation descriptions, not direct visual observation. The parent task can inspect them through an enabled browser surface.

## Small host feasibility checks, only if the selected concept depends on them

1. Register mock navigation and assistant views in Primary/Secondary Sidebar, open a native diff, then move views into the Panel and reverse the Primary Sidebar position.
2. Open evidence at a line in another native editor, return to the finding, and verify keyboard focus/return behavior.
3. Render mocked existing discussion and a local draft using native comment surfaces; verify line/file anchors and destination labels.
4. Resize views, zoom, switch light/dark/high contrast, navigate by keyboard, then hide/reopen the assistant.
5. Restore a saved mocked review after reloading the host. Verify last file/checkpoint, draft text, stale-source banner, and cancellation state.

These checks establish interface feasibility only. They do not establish GitHub synchronization, publication semantics, AI quality, repository context retrieval, or productivity.

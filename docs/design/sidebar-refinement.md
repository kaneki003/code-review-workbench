# Left sidebar refinement

This note records component changes and checks at that stage. The [current contract](figma-interaction-contract.md) and [later lifecycle refinement](lifecycle-refinement.md) govern current writing, dismissal, publication, and activity behavior. Earlier screen/instance counts are historical evidence.

Current editable file: https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU

Reference examples: https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU?node-id=41-2818

The supplied Stitch crop governs the left column’s geometry and surface treatment. The supplied palette identifies Inter for interface text and JetBrains Mono for code-style labels. Primary blue is #007ACC. Sampled sidebar surfaces preserve the screenshot’s hierarchy; purple and tertiary blue are recorded for later companion/centre refinement. The PRD and older exploration files provide product context, not new instructions or authority to publish reviews.

The Sidebar master is 334px wide and contains the PR Workbench title, PR-number chip and three-dot workbench menu; one stacked repository/PR section with compact 36px selectors; a Views section with editable SVGs and metadata; status-labelled checkpoints; and single-line file rows with review squares, file/type icons and line totals. Selected view, checkpoint and file rows share a two-pixel blue edge. Section backgrounds and separators match the reference. No persistent Sync/Submit/Exit footer remains. Those actions and draft discovery retain their previous state-specific routes in the anchored three-dot popup.

One master component is reused in 39 main prepared states. Nested navigation, checkpoint and file-row families share typography, spacing and semantic variables. Eleven Lucide SVG assets remain editable vectors; icon roles use component swaps. The filtered, All-files and light examples are instances, not flattened images. Long filenames intentionally ellipsize; narrow and All-files lists scroll within the sidebar.

The clarified fixture has six unique changed files: Permissions contains two, Request lifecycle contains one, and Worker & output contains worker.ts, worker.test.ts and export_queue.ts. The latter list shows three files while Changed Files and Show all files show six. New All-files Request and Queue states preserve All-files mode when either file is selected. Line totals are coherent: Permissions +226/−12, Request +84/−12, Worker +310/−24, and All +620/−48. These remain authored example data.

Saved inspection passed for all 39 shared instances, 195 popup/tooltip visibility bindings, correct file counts/membership, expected Inter/JetBrains Mono fonts, valid saved sidebar destinations, no footer strips and no image-filled UI layers. Shared examples, wide, narrow, light and open-menu compositions were visually inspected. This is design and saved-graph validation; live Figma player interaction, native VS Code behavior and real external actions were not exercised.

State and exact IDs live in figma-sidebar-state.json, figma-sidebar-components.json, figma-sidebar-inline-panels.json, the seven apply ledgers and figma-sidebar-checks.json. Future visual edits should update the shared Sidebar and nested row masters; use overrides only for scope, active state, text, visibility and prepared-state routes. Do not independently redraw sidebars in screenshots or detach their instances.

The SVG sources are from https://github.com/lucide-icons/lucide. Their license is preserved in sidebar-assets/LICENSE.

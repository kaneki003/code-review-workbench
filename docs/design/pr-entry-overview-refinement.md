# PR entry, Markdown overview, and central File role refinement

The [lifecycle refinement](lifecycle-refinement.md) supersedes earlier dedicated resume/publication/activity destinations. The PR entry and Markdown overview decisions below remain in force.

Updated 15 October 2026 in the existing [Figma file](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU).

Screen 01 (`6:2`) now adds/opens a PR outside the existing review list by URL. The duplicate repository selector, existing PR card, and Resume recent review action are removed. Repository/PR selection remains in the approved sidebar. Choosing the existing PR from entry restores the prepared saved review through the [current lifecycle wiring](figma-lifecycle-rewired.json); choosing the already-active PR elsewhere closes the popup and preserves that prepared state. This is a saved Figma route, not implemented persistence.

Screen 02 (`6:3`) is an ordinary editor tab named `PR-248-Overview.md`, with a vertically scrolling Markdown document. Its scope is identity and standard metadata, labelled AI intent and summary, original author description, six linked changed files with statistics, and three checkpoints with purpose, context, and grouped files. The later lifecycle refinement removes the separate Review activity page; inline collaborator threads and the GitHub PR discussion link remain outside this overview. The document has six total changed files and three under Worker & output, totalling +620/−48.

The current #248 fixture supplied title, repository, author, branches, head, filenames, grouping and statistics. The user explicitly authorized generating missing dummy data. Open status, four commits, and the author description are new dummy fixture content; they are not fetched GitHub facts. The exact author Markdown is saved in `pr-248-author-description.md` and rendered separately from the AI summary. Do not copy facts from the older northstar/atlas #184 scenario.

Eleven redundant central File role blocks were removed, including screens 05 and 06 and prepared permission/test/request/queue variants. The approved sidebar's visual structure and shared master, companion context layout, code rows, inline writing, and unrelated review workflows remain intact. Only the required existing-PR selection behavior changed in sidebar instances.

Ten reusable local components cover Markdown typography, metadata rows, changed-file rows, list items, checkpoint content, the complete overview document and the PR URL form. Existing input, button and tab masters are reused. All new UI is editable text and component instances; there are no image-filled UI layers. Existing semantic color and spacing variables are reused.

State: `figma-pr-refinement-state.json`. Exact applied IDs and deletions: `figma-pr-refinement-applied.json`. Final checks: `figma-pr-refinement-checks.json`. Reusable masters live on page `3:2`; the overview document is `88:10882`, with screen instance `89:11402`. The PR form master is `88:10997`, with screen instance `89:11374`.

Visual review covered entry, overview, the entire document, and screens 05/06. Structural validation passed counts, links, font families, editable layers, sidebar/companion geometry, and absence of the removed pattern. Live Figma player interaction, arbitrary URL input, and native editor persistence were not exercised.

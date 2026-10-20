# Code Review Workbench

Implementation workspace for the planned AI-assisted VS Code code review extension. Keep application source and technical design documents here; track engineering work in [GitHub Issues](https://github.com/kaneki003/code-review-workbench/issues).

This repository contains the accepted planning baseline, installable readiness, shared private-store ownership, a verified PR overview, committed PR diffs with explicit Reviewed marks, anchored private local drafts and PR checkout/Exit recovery. A [working checkpoint for prior-work preservation](docs/development/prior-work.md) extends Enter/Exit to supported staged, unstaged and new-file work; its full fault/platform acceptance remains open. Review-time edit preservation remains a later ticket.

## Run the readiness slice

Use Node >=24.15.0 <25 and pnpm 12.11.2. Building the native helper also needs Python and a C++ toolchain; see the [helper build requirements and walkthrough](docs/development/shared-state-ownership.md#approved-packaging-change).

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

Install `dist/code-review-workbench.vsix` with VS Code's **Extensions: Install from VSIX…** command, open a trusted, already-cloned local folder and run **Code Review Workbench: Check Readiness**. Extension users need Git on PATH and VS Code >=1.141.2; a separate Node installation and development server are unnecessary.

The check reports the real host, Git and packaged in-memory SQLite worker. It does not create private review data or start a review. See the [implementation walkthrough and development commands](docs/development/readiness.md) and [validation evidence and limits](docs/development/readiness-validation.md).

The [native ownership helper for #18](docs/development/shared-state-ownership.md) is approved and packaged. Explicit Open/Release Private Store commands coordinate one owner across windows. Recover Private Store reconciles interrupted typed operations without replaying Git. The guarded Git interface updates workbench-owned references and fetches verified PR source; it is not an arbitrary command runner. Install the VSIX built for your OS and CPU.

Run **Code Review Workbench: Open Pull Request Overview** in the root of an existing local repository, paste a GitHub.com PR URL and sign in through VS Code. The overview retains the selected local copy and verified account/repository identities in the owning private store. It shows real metadata and the author description in a read-only Markdown tab/preview. API sign-in does not configure Git transport. See the [implementation walkthrough, try-out steps and validation limits](docs/development/pr-overview.md).

Then run **Code Review Workbench: Inspect Committed PR Diffs**. The Changed Files sidebar lists the complete local Git comparison and opens ordinary native diffs. **Open Exact-Revision Source** and **Return to Committed Source** preserve committed sides/ranges. Use the explicit **Mark File Reviewed** / **Remove Reviewed Mark** actions to save human progress. This is no-switch reading: working files and ordinary terminals stay on their earlier checkout. See the [source walkthrough, recovery steps and limits](docs/development/committed-source.md).

Select a committed source range and choose **Write Private Local Draft**. The movable **Private Feedback** panel saves through the host and shows the exact original target. Close/Escape saves before returning to source; **Show Local Drafts** and native tags reopen the same record. Discard deletes that identity. Drafting sends nothing to GitHub and starts no AI request. See the [draft walkthrough, try-out steps and recovery limits](docs/development/local-drafts.md).

For day-to-day work, run `pnpm format` after editing and `pnpm validate` before committing. Validation checks formatting, TypeScript types and the fast tests. `pnpm test:host` separately builds and installs the VSIX in a disposable VS Code profile. VS Code recommends the Prettier extension for formatting on save; the command-line checks use the pinned local formatter even without that editor extension.

From a clean supported repository, **Code Review Workbench: Enter PR Checkout** saves and captures the original editor state, then enters the exact PR on a fresh owned branch. **Exit Review** verifies the original branch/commit, clean files and editor state before completion. **Recover PR Checkout** reconciles interrupted transitions in the affected repository. Unfinished work stops switching and retains no-switch reading. See the [checkout walkthrough, recovery actions and representation limits](docs/development/clean-checkout.md).

## Project layout

- `src/`: extension entry, readiness manager, Git/worker connections and React view.
- `tests/`: behavior, React interaction and installed-host checks.
- `scripts/`: explicit build and packaged-host test pipelines.
- `docs/product/`: approved PRD in Markdown/PDF and the product decision history.
- `docs/design/`: current UI contract, refinement notes, Figma links, state/check ledgers, and SVG reference assets.
- `docs/research/`: dated VS Code host-feasibility research relevant to architecture.
- `docs/agents/`: engineering workflow configuration.
- `AGENTS.md`: instructions for agents working in this project.
- `.agents/skills/`: the installed Matt Pocock skills and their supporting files.
- `skills-lock.json`: installed skill source and integrity metadata.

## Product and design inputs

Read the design baseline index before using a component note or an older state ledger.

- [PRD v0.3, amended 16 October: committed-code review only](docs/product/PRD.md); the [11 October PDF booklet](docs/product/PRD.pdf) is historical.
- [Accepted technical design and first working milestone](docs/design/technical-design.md): scoped personal-local handoff; public-release approval remains separate.
- [Current design baseline and source precedence](docs/design/README.md).
- [Selected interface interaction contract](docs/design/figma-interaction-contract.md).
- [Architecture questions and native host checks](docs/design/interface-feasibility-questions.md).
- [Product alignment decision history](docs/product/product-alignment-decision-log.md).
- [Import provenance and reconciliation notes](docs/baseline-import.md).

The imported baseline is local to this repository. The enclosing workspace retains the original research, historical prototypes, design automation, and generated artifacts as source records. Editable UI screens remain in the [Figma design file](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU).

## Engineering workflow

Work from this directory when using the project skills. GitHub Issues tracking, the default triage labels, and single-context domain documentation are configured in the [documentation index](docs/README.md).

Create the technical design under `docs/design/` as architectural decisions are resolved. Keep terminology in a root `GLOSSARY.md` and significant architectural decisions in `docs/adr/`, creating them when there is agreed content to record.

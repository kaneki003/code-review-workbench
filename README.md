# Code Review Workbench

Implementation workspace for the planned AI-assisted VS Code code review extension. Keep application source and technical design documents here; track engineering work in [GitHub Issues](https://github.com/kaneki003/code-review-workbench/issues).

This repository contains the accepted planning baseline and the first production extension slice: an installable, read-only readiness command. Review entry and private-state writes remain unavailable until their implementation tickets are completed.

## Run the readiness slice

Use Node >=24.15.0 <25 and pnpm 12.11.2. Building the native helper also needs Python and a C++ toolchain; see the [helper build requirements and walkthrough](docs/development/shared-state-ownership.md#approved-packaging-change).

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

Install `dist/code-review-workbench.vsix` with VS Code's **Extensions: Install from VSIX…** command, open a trusted, already-cloned local folder and run **Code Review Workbench: Check Readiness**. Extension users need Git on PATH and VS Code >=1.141.2; a separate Node installation and development server are unnecessary.

The check reports the real host, Git and packaged in-memory SQLite worker. It does not create private review data or start a review. See the [implementation walkthrough and development commands](docs/development/readiness.md) and [validation evidence and limits](docs/development/readiness-validation.md).

The [native ownership helper for #18](docs/development/shared-state-ownership.md) is approved and packaged. Shared-store ownership and durable recovery remain unfinished; passing the helper probe does not enable review writes. Install the VSIX built for your OS and CPU.

For day-to-day work, run `pnpm format` after editing and `pnpm validate` before committing. Validation checks formatting, TypeScript types and the fast tests. `pnpm test:host` separately builds and installs the VSIX in a disposable VS Code profile. VS Code recommends the Prettier extension for formatting on save; the command-line checks use the pinned local formatter even without that editor extension.

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

# Code Review Workbench

Implementation workspace for the planned AI-assisted VS Code code review extension. Keep application source, technical design documents, and engineering tickets in this directory.

This repository contains the approved product baseline, the selected UI design handoff, and the engineering skills configuration. Production extension code and framework choices are still to be developed.

## Project layout

- `src/`: application source; currently empty.
- `docs/product/`: approved PRD in Markdown/PDF and the product decision history.
- `docs/design/`: current UI contract, refinement notes, Figma links, state/check ledgers, and SVG reference assets.
- `docs/research/`: dated VS Code host-feasibility research relevant to architecture.
- `docs/agents/`: engineering workflow configuration.
- `AGENTS.md`: instructions for agents working in this project.
- `.agents/skills/`: the installed Matt Pocock skills and their supporting files.
- `skills-lock.json`: installed skill source and integrity metadata.
- `.scratch/<effort>/`: local specs, decision maps, and tickets, created when needed.

## Product and design inputs

Read the design baseline index before using a component note or an older state ledger.

- [Approved PRD v0.3](docs/product/PRD.md) and [PDF booklet](docs/product/PRD.pdf).
- [Current design baseline and source precedence](docs/design/README.md).
- [Selected interface interaction contract](docs/design/figma-interaction-contract.md).
- [Architecture questions and native host checks](docs/design/interface-feasibility-questions.md).
- [Product alignment decision history](docs/product/product-alignment-decision-log.md).
- [Import provenance and reconciliation notes](docs/baseline-import.md).

The imported baseline is local to this repository. The enclosing workspace retains the original research, historical prototypes, design automation, and generated artifacts as source records. Editable UI screens remain in the [Figma design file](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU).

## Engineering workflow

Work from this directory when using the project skills. Local tracking, the default triage labels, and single-context domain documentation are configured in the [documentation index](docs/README.md).

Create the technical design under `docs/design/` as architectural decisions are resolved. Keep terminology in a root `GLOSSARY.md` and significant architectural decisions in `docs/adr/`, creating them when there is agreed content to record.

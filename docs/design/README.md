# UI Design Baseline

Repository handoff baseline: 15 October 2026. The selected direction uses the school-account Figma file and the latest centre, PR entry, Chat, and lifecycle refinements.

The [accepted extension architecture](extension-architecture.md), confirmed on 15 October 2026 through [Choose extension architecture and framework](https://github.com/kaneki003/code-review-workbench/issues/6), selects one local desktop TypeScript extension with React/Tailwind views, pnpm, host-owned review state and explicit build/test/version constraints. It preserves ordinary code/diff tabs and the accepted Figma-styled bottom feedback composer. It also adds PR-wide and unanchored discussion to the existing Markdown PR overview, with Reply opening that composer. The separate Review activity page remains removed. Other design requirements and the documented native validation limits remain binding; the overall technical design still awaits the remaining map decisions.

## Visual source

- [Editable Figma design](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU).
- [Main review prototype](https://www.figma.com/proto/iUydEGUJkOMhggD3wMTFKU?node-id=6-2&starting-point-node-id=6%3A2).
- [In-file interaction rules](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU?node-id=28-2364).

Open Figma for the full visual screens. This repository carries the written handoff, saved state/check ledgers, and editable SVG reference assets.

## Read in this order

1. [Product requirements](../product/PRD.md) for agreed scope and product obligations.
2. [Current interaction contract](figma-interaction-contract.md) for the selected interface behavior, reconciled with the later refinements.
3. [Prototype guide](figma-prototype-guide.md) for the prepared journey and explicit interaction limits.
4. [Architecture questions and host checks](interface-feasibility-questions.md) for unresolved implementation work.

## Refinement precedence

The following notes explain the decisions reflected in the current contract. A later note supersedes an earlier note only in its stated scope.

| Scope | Source | Current treatment |
| --- | --- | --- |
| Drafts, dismissal, publication, discussion navigation | [Lifecycle refinement](lifecycle-refinement.md) | Tagged inline drafts; Close retains text; Dismiss immediately hides; publication confirms inside the workspace; separate Review activity page removed |
| PR entry and overview | [PR/Markdown refinement](pr-entry-overview-refinement.md) | URL entry for an added PR; existing PRs use sidebar selectors; overview is an ordinary Markdown editor tab; redundant central File role blocks removed |
| PR-wide and unanchored discussion | [Accepted architecture](extension-architecture.md) | Existing overview gains PR discussion for PR-level comments, submitted review summaries and unavailable-source threads; Reply opens the existing bottom composer |
| Chat generation and recovery | [Chat refinement](chat-state-refinement.md) | Stop retains produced text; retry preserves question/history; Figma simulates streaming with timed snapshots |
| Inline reading and writing | [Centre refinement](centre-refinement.md) | Source-anchored cards and inline composer; right companion remains Context / Chat |
| Companion context and conversation | [Companion refinement](companion-refinement.md) | Shared Context / Chat layout and context hierarchy |
| Navigation | [Sidebar refinement](sidebar-refinement.md) | Shared sidebar, six total changed files, three Worker & output files, anchored workbench menu |

The latest source guide records 35 prepared-state frames and 16 overlays after lifecycle cleanup. Earlier component counts and graph checks remain evidence of those earlier stages.

## Fixture and evidence

The fixture is fictional: `acme/export-service`, PR #248, six changed files, initial inspected head `7e93a1`, and newer-source examples at `9c24b6e`. People, findings, commands, GitHub outcomes, and PR metadata are authored example data.

- [Exact fictional author-description Markdown](pr-248-author-description.md).
- [Latest lifecycle state](figma-lifecycle-state.json), [wiring](figma-lifecycle-rewired.json), and [checks](figma-lifecycle-checks.json).
- [PR entry/overview state](figma-pr-refinement-state.json) and [checks](figma-pr-refinement-checks.json).
- [Chat state](figma-chat-state-refinement.json), [checks](figma-chat-state-checks.json), and [retention checks](figma-chat-retention-check.json).
- [Sidebar state](figma-sidebar-state.json) and [checks](figma-sidebar-checks.json).
- [Companion state](figma-companion-state.json) and [checks](figma-companion-checks.json).
- [Centre state](figma-centre-state.json) and [checks](figma-centre-checks.json).
- [SVG asset license](sidebar-assets/LICENSE).

The JSON files are exported design evidence. Earlier ledgers may contain retired frames; the latest lifecycle ledgers govern surviving destinations. They are not extension configuration or a runtime architecture.

## Implementation boundaries

Validation so far covers visual inspection and saved Figma interactions. Live player click-through, free typing, real AI streaming, durable persistence, GitHub delivery, Git checkout/restoration, keyboard/focus, and native VS Code behavior remain unverified.

Carry those boundaries into technical planning. In particular, inline autosave integration, workspace preservation, source freshness, publication receipts, and discoverability of PR-wide/unanchored records need explicit implementation decisions. The native host spike remains deferred in the source decisions.

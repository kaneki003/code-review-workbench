# Project Documentation

Store the implementation project's documentation here. The imported baseline is self-contained within this repository.

## Product and design baseline

- [Product requirements](product/README.md): approved PRD and decision history.
- [UI design handoff](design/README.md): current contract, refinement precedence, Figma references, and saved evidence.
- [Accepted extension architecture](design/extension-architecture.md): TypeScript/React/Tailwind, pnpm, local review ownership, native surfaces and required validation.
- [Accepted Git/source lifecycle](design/git-source-lifecycle.md): existing-folder stash/checkout/restoration, repository-scoped recovery, exact source identities and Sync reconciliation.
- [Accepted private-state storage](design/private-state-storage.md): shared local SQLite/worker storage, save acknowledgments, ownership, backups, clearing and recovery; detailed local-to-later-PR linking is deferred to implementation by the owner.
- [Accepted GitHub collaboration](design/github-collaboration.md): built-in sign-in, discussion/pending-review reads, exact composition, uncertain-delivery recovery, source guards and separate merge/queue outcomes, with provider tests still required.
- [Host-feasibility research](research/README.md): dated research to carry into technical planning.
- [Baseline import notes](baseline-import.md): source provenance, reconciled inconsistencies, and validation boundaries.

## Engineering configuration

- [Issue tracker](agents/issue-tracker.md): GitHub specs, implementation tickets, and wayfinding operations.
- [Triage labels](agents/triage-labels.md): the five default triage statuses.
- [Domain documentation](agents/domain.md): glossary and architectural decision conventions.
- [Product glossary](../GLOSSARY.md): the agreed vocabulary for review context, source freshness, drafts and publication.

The [technical-design Wayfinder map](https://github.com/kaneki003/code-review-workbench/issues/1) tracks the open planning decisions and their dependencies. Research evidence is linked from its decision issues; it is not an accepted architecture until the relevant decisions resolve.

## Documents to create as work progresses

- `design/technical-design.md`: architecture, technology choices, verification approach, and implementation milestones; to be written after decisions are resolved.
- `adr/`: significant architectural decisions involving real tradeoffs.
- `../GLOSSARY.md`: agreed project terminology.

Specs, tickets, and wayfinding maps live in [GitHub Issues](https://github.com/kaneki003/code-review-workbench/issues), as described in the issue-tracker configuration. Keep technical design documents and supporting artifacts in this repository and link them from the relevant issues.

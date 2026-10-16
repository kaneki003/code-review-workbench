# UI Design Baseline

Repository handoff baseline: 15 October 2026. The selected direction uses the school-account Figma file and the latest centre, PR entry, Chat, and lifecycle refinements.

**Owner scope amendment — 16 October:** review committed code only. Local commit/branch comparisons remain; uncommitted-review entry and private index/worktree review snapshots are removed. Commit further edits, then Sync for the next review iteration. Preservation stashes still protect unfinished work. The [amended Markdown PRD](../product/PRD.md) supersedes the historical PDF on this scope.

The [accepted personal-local technical design](technical-design.md) joins the contracts, traces FR01–FR20 and defines the first runnable milestone and ordered implementation. The owner accepted the revised design and milestone on 16 October through [Accept the technical design and first working milestone](https://github.com/kaneki003/code-review-workbench/issues/11). Public-release approval and actual runtime validation remain separate.

The [accepted extension architecture](extension-architecture.md), confirmed on 15 October 2026 through [Choose extension architecture and framework](https://github.com/kaneki003/code-review-workbench/issues/6), selects one local desktop TypeScript extension with React/Tailwind views, pnpm, host-owned review state and explicit build/test/version constraints. It preserves ordinary code/diff tabs and the accepted Figma-styled bottom feedback composer. It also adds PR-wide and unanchored discussion to the existing Markdown PR overview, with Reply opening that composer. The separate Review activity page remains removed. Other design requirements and the documented native validation limits remain binding in the accepted personal-local handoff.

Technical planning is tracked in the [Code Review Workbench technical-design map](https://github.com/kaneki003/code-review-workbench/issues/1). Its child decisions cover host feasibility, architecture/framework, Git/source lifecycle, persistence, GitHub collaboration, subscription-based AI integration and the first working milestone. The personal-local design is accepted; the map stays open for provider eligibility and public-release reconciliation. The UI baseline below remains the product/design input.

On 16 October the owner accepted the [AI investigation contract](ai-investigation.md) through [Choose AI runtime and investigation contracts](https://github.com/kaneki003/code-review-workbench/issues/10) for interim personal-local development planning: direct ChatGPT-plan requests, an extension-owned tool loop, protected remembered logins, an always-available model selector, retained same-PR conversation, bounded work and explicit recovery. A running attempt keeps its model; a new selection applies to the next attempt, with Stop/Retry available for the current question. Actual authorization/inference and packaged-runtime/containment fixtures remain unverified. The personal-local eligibility assumption for this particular proprietary product remains provisional. The owner subsequently accepted the explicitly scoped [personal-local technical-design handoff](https://github.com/kaneki003/code-review-workbench/issues/11); its first working milestone remains the non-AI local review loop. ChatGPT and Gemini remain intended public providers. Their open eligibility tasks gate a separate [public-release design review](https://github.com/kaneki003/code-review-workbench/issues/14), so provider responses do not block local planning or establish distribution approval. The overall map remains open until its required decisions are resolved.

The [accepted Git/source lifecycle](git-source-lifecycle.md), confirmed through [Choose Git preservation and source synchronization contracts](https://github.com/kaneki003/code-review-workbench/issues/7) and amended by the owner's committed-only scope, uses the existing local folder with verified save/stash/checkout/restoration, separate review-time stashes and repository-scoped interrupted-transition recovery. It defines exact committed-source identities, local committed comparisons and Sync reconciliation. Implementations and the required cross-platform preservation fixtures remain pending.

The [accepted private-state storage](private-state-storage.md), confirmed through [Choose durable private state and recovery storage](https://github.com/kaneki003/code-review-workbench/issues/8), selects a shared per-OS-user SQLite store through the built-in Node driver in a packaged worker, ordered save acknowledgments, account isolation, cross-window ownership, backups, migrations and clear/recovery rules. The driver is a release candidate in the selected host runtime; packaging, guard/durability, corruption and deletion fixtures remain implementation gates. The owner explicitly deferred detailed local-to-later-PR linking to implementation; do not treat that workflow as fully specified.

The [accepted GitHub collaboration contract](github-collaboration.md), confirmed through [Choose GitHub collaboration and delivery contracts](https://github.com/kaneki003/code-review-workbench/issues/9), selects built-in GitHub sign-in, Octokit with REST/GraphQL, independently refreshed/paginated discussion, actual pending-review membership, conservative delivery recovery and head-guarded separate merge/queue operations. The owner accepts documented last-second code/content races, explicit handling of older pending reviews and linked PR-wide replies. Provider/package/fault fixtures remain implementation gates within the accepted personal-local technical design.

The [accepted native-host amendment](https://github.com/kaneki003/code-review-workbench/issues/5#issuecomment-6190598100), confirmed by the owner on 15 October 2026, moves only feedback writing to a bottom panel. Preserve the Figma composer's styling and internal layout; all other approved behavior stays the same, including anchored inline reading and Context / Chat in the companion. Prepared Figma frames still show the former inline placement. The plain host experiment is evidence of behavior, not the accepted visual design.

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
| GitHub composition, recovery and source limits | [Accepted GitHub collaboration](github-collaboration.md) | Actual remote pending membership, explicit older-batch Comment before fresh decision, visible PR-wide reply links and no uncertain resend; preflight/content races are documented |
| Chat generation and recovery | [Chat refinement](chat-state-refinement.md) | Stop retains produced text; retry preserves question/history; Figma simulates streaming with timed snapshots |
| Inline reading and feedback writing | [Centre refinement](centre-refinement.md), amended by the [accepted host decision](https://github.com/kaneki003/code-review-workbench/issues/5#issuecomment-6190598100) | Source-anchored reading; Figma-styled feedback composer moved to the bottom panel; right companion remains Context / Chat |
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

Figma validation covers visual inspection and saved interactions. A [bounded native VS Code experiment](https://github.com/kaneki003/code-review-workbench/blob/458c92b4bdbda91fd85906333cfe778316c22784/docs/research/wayfinder-native-host-prototype.md) additionally exercised real draft typing, acknowledged saves, Close/reload/recreation, simulated failed saves and Retry, source anchors/navigation, movable views, narrow reflow and host theme changes on macOS. It does not establish Figma visual parity, full keyboard/screen-reader behavior, production durability, other desktop platforms, real AI, GitHub delivery or Git checkout/restoration.

Carry those boundaries into technical planning. The [Git/source contract](git-source-lifecycle.md) selects workspace preservation, recovery and source freshness behavior, the [storage contract](private-state-storage.md) selects durable private state and recovery rules, and the [GitHub contract](github-collaboration.md) selects discussion, publication/receipt and merge behavior. Their implementations and fixtures remain pending. Native visual/focus constraints and provider behavior still require validation. Detailed local-to-PR linking is owner-deferred. The host decision approves the composer placement change only.

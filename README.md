# Code Review Workbench

Implementation workspace for the planned AI-assisted VS Code code review extension. Keep application source and technical design documents here; track engineering work in [GitHub Issues](https://github.com/kaneki003/code-review-workbench/issues).

This repository contains the accepted planning baseline, installable readiness, a verified PR overview, committed PR diffs with explicit Reviewed marks, anchored private local drafts and a PR checkout/Exit flow based on ordinary Git. Enter preserves staged, unstaged and nonignored new-file work in a named stash; Exit applies it with index restoration. Failed commands expose their real diagnostics and leave recovery to the user. Platform and installed-host validation remain open in [draft PR #36](https://github.com/kaneki003/code-review-workbench/pull/36). Review-time edit preservation remains a later ticket.

## Run the readiness slice

Use Node >=24.15.0 <25 and pnpm 12.11.2. Building the native helper also needs Python and a C++ toolchain; see the [helper build requirements and walkthrough](docs/development/shared-state-ownership.md#approved-packaging-change).

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

Install `dist/code-review-workbench.vsix` with VS Code's **Extensions: Install from VSIX…** command, open a trusted, already-cloned local folder and run **Code Review Workbench: Check Readiness**. Extension users need Git on PATH and VS Code >=1.141.2; a separate Node installation and development server are unnecessary.

The check reports the real host, Git and packaged in-memory SQLite worker. It does not create private review data or start a review. See the [implementation walkthrough and development commands](docs/development/readiness.md) and [validation evidence and limits](docs/development/readiness-validation.md).

The private-state architecture is being simplified under [ADR 0007](docs/adr/0007-coordinate-review-state-per-repository.md): different repositories/windows may work concurrently, while a repository-local receipt excludes overlapping transitions in the same checkout. The older native global-ownership implementation remains in the tree only while source/draft storage is migrated away from it.

Run **Code Review Workbench: Open Pull Request Overview** in the root of an existing local repository, paste a GitHub.com PR URL and sign in through VS Code. The overview retains the selected local copy and verified account/repository identities in the owning private store. It shows real metadata and the author description in a read-only Markdown tab/preview. API sign-in does not configure Git transport. See the [implementation walkthrough, try-out steps and validation limits](docs/development/pr-overview.md).

Then run **Code Review Workbench: Inspect Committed PR Diffs**. The Changed Files sidebar lists the complete local Git comparison and opens ordinary native diffs. **Open Exact-Revision Source** and **Return to Committed Source** preserve committed sides/ranges. Use the explicit **Mark File Reviewed** / **Remove Reviewed Mark** actions to save human progress. This is no-switch reading: working files and ordinary terminals stay on their earlier checkout. See the [source walkthrough, recovery steps and limits](docs/development/committed-source.md).

Select a committed source range and choose **Write Private Local Draft**. The movable **Private Feedback** panel saves through the host and shows the exact original target. Close/Escape saves before returning to source; **Show Local Drafts** and native tags reopen the same record. Discard deletes that identity. Drafting sends nothing to GitHub and starts no AI request. See the [draft walkthrough, try-out steps and recovery limits](docs/development/local-drafts.md).

For day-to-day work, run `pnpm format` after editing and `pnpm validate` before committing. Validation checks formatting, TypeScript types and the fast tests. `pnpm test:host` separately builds and installs the VSIX in a disposable VS Code profile. VS Code recommends the Prettier extension for formatting on save; the command-line checks use the pinned local formatter even without that editor extension.

From a local repository, **Code Review Workbench: Enter PR Checkout** asks VS Code to save dirty documents, uses `git stash push --include-untracked` when needed, records the stash object and switches to the exact PR commit in detached mode. **Exit Review** switches back and runs `git stash apply --index`; VS Code retains responsibility for its own editor state. A failed command shows its command, exit code and Git output and retains the bounded checkout receipt for manual recovery. One review may be active per repository/window, and different repositories may be reviewed concurrently. See [ADR 0006](docs/adr/0006-use-ordinary-git-for-review-checkouts.md).

## Project layout

Code is grouped by engineering responsibility. See the [code layout and dependency rules](docs/development/code-layout.md) for the file map, test organization and migration limits.

```text
src/
  extension.ts       # extension startup and implementation wiring
  application/       # operation coordination and host-owned state
  domain/            # identities, contracts and pure rules
  git/               # checkout, committed reads and repository discovery
  github/            # GitHub communication and response normalization
  storage/           # SQLite, worker communication and persistence
  native/            # TypeScript native-helper probes (pending migration)
  protocol/          # browser-safe messages and validators
  vscode/            # documents/ and views/ using the VS Code API
  webviews/          # drafts/ and readiness/ browser entries and React views
```

- `tests/`: matching responsibility folders, installed-VSIX `host/` suites, separately authorized `provider/` reads and reusable `support/` fixtures.
- `native/`: existing C++ helper and build definition; retained until the storage migration removes its callers.
- `scripts/`: explicit build, packaging and test pipelines.
- `docs/product/`: approved PRD and product decision history.
- `docs/design/`: current architecture/UI contracts and design reference evidence.
- `docs/development/`: code navigation, implementation walkthroughs and validation records.
- `docs/research/`: dated feasibility research.
- `docs/agents/`, `AGENTS.md`, `.agents/skills/`: agent workflow instructions and project skills.

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

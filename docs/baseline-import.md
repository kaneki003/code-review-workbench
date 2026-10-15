# Product and UI Baseline Import

Baseline date: 15 October 2026. Imported into the standalone implementation repository before its initial commit.

## Included material

- Approved PRD v0.3 in Markdown and PDF, and the product alignment decision history.
- Selected UI interaction contract, prototype guide, six refinement notes, fictional PR description, and architecture questions.
- Referenced Figma state/check/wiring JSON records and sidebar SVG assets with their license.
- The two host-feasibility research records relevant to later technical decisions.

The [manifest](baseline-manifest.json) records each source path, destination, source SHA-256, destination SHA-256, and any adjustments. Source paths identify the enclosing research workspace; they are provenance rather than dependencies of this repository. The original research files remain in place.

## Reconciled handoff inconsistencies

- Replaced parent-workspace and Windows-local navigation with repository-relative links.
- Updated the base contract and guide to the selected inline composer and anchored local drafts.
- Applied immediate suggestion dismissal and in-workspace publication confirmation.
- Removed the superseded separate Review activity destination and dedicated resume/publication instructions.
- Replaced the retired resume-frame reference with the current lifecycle wiring.
- Updated the guide to the latest recorded 35-frame/16-overlay inventory and labelled earlier counts as historical.
- Preserved the exact fictional author Markdown in a fenced example; its relative test-file link belongs to the fictional repository.

The PRD, PDF, decision history, research records, SVG assets, and exported JSON evidence retain their original content. Normalized handoff documents have adjustment notes and separate destination hashes in the manifest.

## Validation scope

The pre-commit check covers repository root, local navigation and containment, JSON parsing, imported-file integrity, skill/lockfile agreement, common credential patterns, ignored local files, and consistency with the latest selected UI decisions. These checks establish the documentation package's integrity and portability.

At baseline-import time, workflow tracking used local Markdown under `.scratch/`. Tracking has since switched to GitHub Issues; see the [current tracker configuration](agents/issue-tracker.md). No architecture, framework, or production implementation is claimed by this baseline.

## Pre-commit check result

Passed on 15 October 2026: the Git root is the implementation directory on `main`; 62 imported files match their recorded hashes; 37 JSON files parse; all 27 installed skills agree with the lockfile; and 147 local links across 74 Markdown files resolve within the repository. Active navigation has no parent-workspace or machine-local dependency.

The common credential-pattern scan and whitespace checks found no matches or issues. Ignore-rule checks preserve the installed skills and local tracker files while excluding local environment configuration, OS metadata, dependencies, logs, and build output. Current UI text agrees with the latest inline-writing, dismissal, publication, and activity-removal decisions. At that check, the Git index was unstaged.

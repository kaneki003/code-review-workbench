# Code Review Workbench

Treat this directory as the repository and implementation project root. Resolve project-relative paths from here.

Before product or architecture planning, read `README.md`, `docs/product/PRD.md`, and `docs/design/README.md` for the baseline and source precedence. Keep implementation source and new project documentation in this directory. Product decision history and earlier Figma ledgers are reference evidence; current user instructions and the reconciled design contract govern new work.

## Implementation workflow

- Work on a feature branch, one ticket at a time.
- Before coding, briefly explain the plan and any new framework concepts. Use `$teach` for deeper lessons when useful.
- Make small, coherent commits. If the change grows large, pause at a working checkpoint for a walkthrough.
- Run the tests and automated code review, then open a draft PR.
- Keep the PR description short and direct. Include “Walk me through the diff”: reading order, one action's flow through the code, key decisions, and how to run and test it.
- Stop for the owner's review. Do not merge, enable auto-merge, close the issue, or start another ticket until the owner explicitly approves.

## Agent skills

### Issue tracker

Specs, implementation tickets, and wayfinding decisions use GitHub Issues in `kaneki003/code-review-workbench`. Before tracker operations, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five triage labels. Before applying a triage label, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before codebase exploration, read `docs/agents/domain.md`.

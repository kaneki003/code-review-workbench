# Code Review Workbench

Treat this directory as the repository and implementation project root. Resolve project-relative paths from here.

Before product or architecture planning, read `README.md`, `docs/product/PRD.md`, and `docs/design/README.md` for the baseline and source precedence. Keep implementation source and new project documentation in this directory. Product decision history and earlier Figma ledgers are reference evidence; current user instructions and the reconciled design contract govern new work.

## Implementation workflow

- Work on a feature branch, one ticket at a time.
- Before coding, briefly explain the plan and any new framework concepts. Use `$teach` for deeper lessons when useful.
- Make small, coherent commits. If the change grows large, pause at a working checkpoint for a walkthrough.
- Run the tests and automated code review, then open a draft PR.
- Scale the PR description to the size and complexity of the change. Follow the PR-Desc Style below for “Walk me through the diff” and how to try it.
- Stop for the owner's review. Do not merge, enable auto-merge, close the issue, or start another ticket until the owner explicitly approves.

## PR-Desc Style

- **Small fixes and UI tweaks:** keep the description brief. Explain the problem, changed behavior and verification; add a reading order where useful.
- **Large or conceptually complex PRs:** give a detailed layered walkthrough, especially for substantial logic or new frameworks, runtimes and architecture. Include enough explanation for a human to understand the purpose, flow, decisions and new concepts without reconstructing them from the source. Let that need determine the length.
- Use plain words, short sentences and focused paragraphs or lists. A detailed description earns its length through explanation, not polished filler, repeated summaries or long formal paragraphs. Keep necessary detail instead of compressing a large PR to meet the small-PR brevity rule.

For a layered walkthrough:

1. **Layers of changes.** Number small layers that can be understood quickly. Explain what each adds and why it is needed. Each layer builds on earlier ones; say when it reuses an earlier command, pipeline or module.
   - Add a user story where useful: what the user does and what happens next.
   - Index and link the relevant files, diffs or functions in their runtime order. Give each step a one-line explanation.
   - Support the runtime index with short explanations of the logic and key decisions. The index is a reading aid, not the whole explanation.
   - Explain new technical terms when introduced: what the concept means, why it is used here and any material tradeoff. For example, explain what a JavaScript worker runs on another thread, or which writes a database transaction makes succeed or fail together.
2. **How to try this feature.** Give exact commands/actions and expected outcomes. Explain how the feature supports a current app user story or will fit a future one.

## Agent skills

### Issue tracker

Specs, implementation tickets, and wayfinding decisions use GitHub Issues in `kaneki003/code-review-workbench`. Before tracker operations, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five triage labels. Before applying a triage label, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before codebase exploration, read `docs/agents/domain.md`.

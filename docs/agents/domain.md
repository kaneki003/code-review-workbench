# Domain Docs

This project uses a single context: `GLOSSARY.md` at the implementation project root and architectural decision records under `docs/adr/`. Resolve these paths from the directory containing this project's `AGENTS.md`.

## Before exploring the codebase

- Read the root `GLOSSARY.md` when it exists.
- Read ADRs under `docs/adr/` that concern the area being explored.
- If these documents are absent, proceed silently. Create them lazily through `domain-modeling` when terms or significant decisions are resolved.

## Use the glossary's vocabulary

Use defined domain terms consistently in issue titles, designs, hypotheses, and test names. When a needed term is missing, check whether it is an existing concept under another name; bring genuine gaps to `domain-modeling`.

## Respect architectural decisions

Follow relevant ADRs. When proposing a conflicting approach, identify the ADR and explain why it should be reconsidered.

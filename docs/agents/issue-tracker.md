# Issue tracker: Local Markdown

Issues, specs, and wayfinding decisions live as Markdown files under `.scratch/`.

Resolve these paths from the implementation project root containing `AGENTS.md`.

## Conventions

- One feature or effort per directory: `.scratch/<feature-slug>/`.
- Spec: `.scratch/<feature-slug>/spec.md`.
- Implementation tickets: one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order.
- Record an implementation ticket's triage state in a `Status:` line near the top. Use the role strings in `triage-labels.md`.
- Record implementation dependencies in `Blocked by:`, using ticket numbers and titles, or `None`.
- Append comments and conversation history under `## Comments`.

## Tracker operations

- Publish a spec or ticket: create its file at the path above, creating directories as needed.
- Fetch a ticket: read the referenced file. Resolve bare numbers within the named feature or effort; ask for the effort when ambiguous.
- List tickets: scan the effort's `issues/` directory and read their status and blockers.

## Wayfinding operations

Decision tickets use the following lifecycle, separate from implementation triage statuses.

- Map: `.scratch/<effort>/map.md`, holding Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- Child ticket: `.scratch/<effort>/issues/<NN>-<slug>.md`, numbered from `01`, with its question in the body.
- Type: a `Type:` line containing `research`, `prototype`, `grilling`, or `task`.
- Status: `open` initially, `claimed` during work, and `resolved` after its decision is recorded.
- Blocking: a `Blocked by:` line containing blocker numbers, or `None`. A ticket is unblocked when every blocker is `resolved`.
- Frontier: scan for `open`, unblocked tickets in the effort's `issues/`; take the lowest number first.
- Claim: save `Status: claimed` before working on the ticket.
- Resolve: append the resolution under `## Answer`, set `Status: resolved`, then append a gist and relative link to the map's Decisions so far.

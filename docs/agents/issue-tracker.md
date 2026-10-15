# Issue tracker: GitHub

Specs, implementation tickets, and wayfinding decisions live in [kaneki003/code-review-workbench Issues](https://github.com/kaneki003/code-review-workbench/issues).

Use GitHub CLI with `--repo kaneki003/code-review-workbench` for issue and label commands. The `origin` remote identifies this repository. Keep technical design documents, the glossary, ADRs, and research artifacts in the repository; link them from the relevant issues.

## Issue operations

- Publish a spec or ticket: `gh issue create --repo kaneki003/code-review-workbench --title "TITLE" --body-file /path/to/body.md`.
- Fetch an issue: `gh issue view ISSUE --repo kaneki003/code-review-workbench --json number,title,body,labels,comments,assignees,state,parent,subIssues,blockedBy,blocking,url`.
- List issues: `gh issue list --repo kaneki003/code-review-workbench --state open --limit 100 --json number,title,labels,assignees,state,parent,blockedBy,url`. Apply label/state filters as needed; increase the limit if the result reaches the cap.
- Update the body: `gh issue edit ISSUE --repo kaneki003/code-review-workbench --body-file /path/to/body.md`.
- Append a comment: `gh issue comment ISSUE --repo kaneki003/code-review-workbench --body-file /path/to/comment.md`.
- Apply/remove labels: `gh issue edit ISSUE --repo kaneki003/code-review-workbench --add-label LABEL` or `--remove-label LABEL`.
- Close a resolved issue: post its resolution first, then `gh issue close ISSUE --repo kaneki003/code-review-workbench`.

Use body files for multiline Markdown. Refer to issues by linked titles in human-facing output.

## Triage conventions

Use the label mapping in [triage-labels.md](triage-labels.md). GitHub issue state records open/closed status; triage role is a label. Specs and tickets produced by `to-spec` and `to-tickets` receive `ready-for-agent` and need no additional triage.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

The map is one GitHub issue; each decision ticket is a sub-issue of that map.

- Map: create an issue labelled `wayfinder:map`, with Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- Child ticket: create with `gh issue create --repo kaneki003/code-review-workbench --parent MAP --title "TITLE" --body-file /path/to/body.md --label wayfinder:TYPE`, where TYPE is `research`, `prototype`, `grilling`, or `task`.
- Existing child: attach with `gh issue edit MAP --repo kaneki003/code-review-workbench --add-sub-issue CHILD`.
- Blocking: use native dependencies, e.g. `gh issue edit CHILD --repo kaneki003/code-review-workbench --add-blocked-by BLOCKER`. Create the issues first, then wire the dependencies using actual issue numbers.
- Inspect the map's children: `gh issue view MAP --repo kaneki003/code-review-workbench --json subIssues`. Fetch each candidate's state, assignees, labels, and blockers as needed.
- Frontier: consider only that map's open, unassigned children whose blockers are all closed; take the first eligible child in map order.
- Claim: `gh issue edit ISSUE --repo kaneki003/code-review-workbench --add-assignee @me`, before work.
- Resolve: append a resolution comment, close the decision ticket, then append a brief gist and linked title to the map's Decisions so far. Preserve the rest of the map when editing its body.

Wayfinding labels are `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, and `wayfinder:task`. Decision tickets carry wayfinder labels rather than implementation triage labels.

If native sub-issues or dependencies are unavailable, record the observed limitation and use a map task list plus `Part of #MAP` and `Blocked by: #ISSUE` body references. Use native relationships whenever supported.

## Tracking ownership

GitHub Issues is the source of truth for work tracking. Local scratch files may hold temporary working material; link repository documents and assets from issues instead of maintaining a second local ticket tracker.

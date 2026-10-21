# Private review state and multi-window coordination

Status: amended 21 October 2026 by [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md). This contract supersedes the global native guard, one-owner handoff, heartbeat/fencing generations and automatic child-process recovery.

## Scope

Store private conversations, drafts, human Reviewed marks, navigation anchors, retained source identities and other resumable PR state locally. Credentials remain in VS Code authentication or secret storage. Git owns repository state; GitHub owns remote review/publication state.

Use SQLite through the desktop extension host's built-in driver. A packaged worker may remain so synchronous database work does not block the extension host, but the worker is an implementation detail rather than an exclusive owner.

## Multi-window model

Each supported local window may open the shared database. Configure WAL, foreign keys and a bounded busy timeout. Keep transactions short and never hold one while awaiting Git, GitHub, AI, filesystem extraction or user input.

Scope records by immutable account, repository and PR identities. Different repositories and windows may read and write their own review data concurrently. SQLite constraints and transactions settle write conflicts; a busy/failed commit is reported as failed rather than converted into an ownership-recovery state.

The product supports one active review per repository/window. A second window may review another repository. Two windows do not drive the same working checkout: the repository-local checkout receipt defined by the [Git lifecycle](git-source-lifecycle.md) enforces that rule.

There is no global store lease, active owner, handoff token, heartbeat, process identity, fencing generation or timeout takeover. Opening one repository must not block another repository's drafts or saved review state.

## Location

The storage root must be local, private to the operating-system user and outside repositories. Whether supported VS Code editions/profiles share one OS-user root or use `ExtensionContext.globalStorageUri` is a packaging decision; it must not change the repository-scoped concurrency model.

The initial implementation may retain the existing OS-user app-data location while the worker is simplified. Remove the separate rendezvous/control files once no supported code depends on global ownership. Do not silently create a second database when a configured existing database is unreadable.

## Data and transactions

Use direct tables for domain records rather than a generic durable request ledger where practical:

- accounts and repository registrations;
- PR/review identity and retained source generations;
- drafts and their current acknowledged revision;
- Reviewed marks and semantic navigation anchors;
- conversation/context and future publication receipts; and
- clear/migration metadata.

Use ordinary SQLite transactions for related database writes. External Git or network effects are never claimed atomic with SQLite. Endpoint-specific publication receipts may still prevent duplicate remote delivery; that concern is separate from checkout recovery.

Draft saving retains the latest input until a database commit is acknowledged. A failed save remains visible with Retry/Copy. The storage layer does not require exclusive ownership of the entire application to save one draft.

## Checkout receipts

Checkout receipts live at the repository seam and contain no conversation or draft content. They remain small and bounded. An interrupted receipt is shown to the user and is never automatically reclaimed through PID inspection, heartbeat age or filesystem inference.

Clearing PR-private data and clearing a checkout receipt are separate explicit actions. Clearing review data does not delete repository work, stashes, GitHub records or account guidance. Clearing a checkout receipt acknowledges that the user has already recovered Git; it performs no recovery itself.

## Migrations, corruption and deletion

Use numbered schema migrations and refuse writes from an unsupported older version to a newer schema. Before a destructive migration, make a verified local backup. An unreadable database presents explicit recovery choices rather than silently replacing it with an empty database.

Clear all app-managed copies of selected private review content while retaining only separately disclosed facts required for incomplete deletion or remote-delivery receipts. Repository-local checkout receipts are outside PR-private content deletion because they protect an unfinished local Git transition.

## Verification

Test through the storage module's interface: two windows using different repositories concurrently, same-PR revision conflicts, SQLite busy/disk/corruption/migration failures, account/repository/PR isolation, draft save/retry/clear behavior, and opening one repository without another window releasing global ownership.

Native process supervision, live-child recovery, global handoff and crash-boundary fault matrices are not part of this contract.

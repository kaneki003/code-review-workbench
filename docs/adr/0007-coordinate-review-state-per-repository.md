---
status: accepted
supersedes: 0003-durable-private-review-state.md
---

# Coordinate review state per repository instead of globally owning the store

Support one active review per repository/window. Different repositories in different VS Code windows may be reviewed concurrently. Two windows must not drive the same working checkout at the same time.

Keep SQLite for durable private review state and keep a packaged worker when off-thread use of the synchronous runtime driver is valuable. Each window may open the shared database. SQLite WAL, short transactions, primary keys and normal busy errors coordinate stored data; callers do not acquire a global store lease or hand the whole store between windows.

Coordinate Git transitions at the repository seam, not the database seam. A repository-local receipt created atomically by the first window excludes another transition in that checkout. An interrupted receipt is not reclaimed through heartbeat, PID inspection or timeout. The user recovers Git and explicitly clears it.

Records are scoped by immutable account, repository and PR identities. A window working in one repository does not block reading or writing review state for another repository. If product UI limits are needed beyond this rule, they are presentation rules rather than global database ownership.

The native ownership/process add-on, global guard, ownership generations, handoff tokens and automatic child recovery are not required by this model.

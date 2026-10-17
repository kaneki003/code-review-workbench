# Shared-store working checkpoint (#18)

Implemented: one canonical store, worker SQLite, native control publication, owner/account scopes, fencing, expected revisions, deduplication, release and acknowledged handoff. #18 remains incomplete. Review entry, content writes and production Git mutations are disabled.

## Evidence

The accepted seams are the public manager, real native/process/filesystem adapters and installed production worker. Tests do not replace ownership with a boolean or inspect SQLite rows to assert behavior.

- Two managers and two real processes find the same registered store with differing candidate data roots. A second window receives only the owning location.
- OS account home resolution ignores process HOME/USERPROFILE overrides; relative data roots are refused on their relevant OS.
- After an owner process dies, exactly one of two reclaimers takes the next generation. Worker death with a still-live host refuses takeover. Heartbeat age grants no authority.
- Retries commit once. Stale release callbacks cannot close a successor's handle. Handoff accepts only the named window/token; other windows remain blocked.
- GitHub accounts retain separate stable scopes while sharing OS-user exclusion.
- Orphan registration, malformed records, damaged database and newer protocol are preserved and refused.
- Linked-worktree/common-Git-directory identities are recorded in sorted order. Pending intent blocks further mutation, release, handoff and reclaim.
- A disposable fixture records intent, launches a child and kills the owning host. The child later changes its disposable repository. The store refuses takeover both before and after completion. This proves the saved barrier, not process containment, dispatch or reconciliation.
- Native tests cover atomic complete record replacement, real exclusion/release, process-start lookup, worker cleanup, directory redirect refusal and replaced-handle refusal.
- Installed-host tests open, renew, hand off, release and reopen the actual worker SQLite store through the packaged manager. Fixtures use an isolated OS-user home; no real user store is opened by tests. Readiness preserves all disposable repository files/index/refs.

`pnpm validate` and `pnpm test:host` are the local gates. CI runs Windows x64, Linux x64 and macOS arm64 at VS Code 1.141.2/current; results are recorded below after completion. A passing helper probe alone does not establish shared-store readiness.

## Standards

The first full implementation review found four issues: descendant settlement, missing independent outcome publication, missing action-specific repository facts, and relative Linux data-root fallback. The unsafe generic Git executor and raw argument transport were removed. The remaining intent seam never authorizes execution and exposes no completion/clear action. Independent intent precedes its database projection. Relative XDG roots are now explicitly refused.

## Spec

The first full implementation review found three issues: top-level Git exit mistaken for descendant completion, raw arguments bypassing repository scopes, and missing repository-fact/failure-boundary proof. Removing production Git execution resolves the active unsafe paths. Expected repository facts, descendant supervision, outcome receipts/reconciliation and full failure injection remain unfinished #18 acceptance work.

This is the large-change walkthrough checkpoint requested by the owner. The draft PR must remain unmerged; the issue stays open.

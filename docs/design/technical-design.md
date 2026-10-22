# Code Review Workbench technical design

Status: amended 21 October 2026 by [ADR 0006](../adr/0006-use-ordinary-git-for-review-checkouts.md) and [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md). The committed-source-only scope remains. Verified byte manifests, automatic Git recovery, native editor-state restoration and global single-window store ownership are superseded by ordinary Git, manual recovery and repository-scoped coordination.

## Scope and reading guide

Build one local desktop VS Code extension for a single junior maintainer. Start with a small usable manual-review loop: open a real PR in an existing local repository, inspect ordinary native diffs, save and reopen an anchored local draft, resume safely and explicitly exit with prior work restored. Add the remaining MVP in dependency order. This first milestone does not redefine MVP.

Review committed code only. The normal iteration is **commit → review → edit → commit → Sync → review**. A local committed comparison can inspect local commits before a PR exists; a PR review follows its actual GitHub PR commits. Saving or staging edits does not update reviewed source. No uncommitted-review mode or private working-tree review snapshot is needed. Protective stashes still preserve unfinished work during checkout/exit.

The handoff is for explicitly scoped personal-local development. The owner's interim exception permits planning the accepted direct ChatGPT-plan connection while this particular proprietary product's eligibility remains provisional. It does not establish successful authorization/inference or authorize public distribution. ChatGPT and Gemini remain intended public account-plan providers; API keys are a separate optional connection kind and cannot satisfy that requirement.

The [PRD](../product/PRD.md) governs product obligations. The [design index](README.md) establishes precedence; the [reconciled interaction contract](figma-interaction-contract.md) governs the selected surfaces. The following accepted contracts own their detailed rules; this document joins them at their interfaces and orders implementation rather than replacing their decision records.

| Contract | Canonical resolution | Responsibility here |
| --- | --- | --- |
| Native host | [Validate anchored reading and autosaved writing in native VS Code](https://github.com/kaneki003/code-review-workbench/issues/5#issuecomment-6190598100) | Native inline reading; Figma-styled bottom writer; remaining focus/visual limits |
| [Architecture](extension-architecture.md) | [Choose extension architecture and framework](https://github.com/kaneki003/code-review-workbench/issues/6#issuecomment-6191239943) | Processes, dependencies, surfaces, build and versions |
| [Git/source](git-source-lifecycle.md) | [Choose Git preservation and source synchronization contracts](https://github.com/kaneki003/code-review-workbench/issues/7#issuecomment-6194035222) | Exact source, preservation, Sync, workspace restoration |
| [Storage](private-state-storage.md) | [Choose durable private state and recovery storage](https://github.com/kaneki003/code-review-workbench/issues/8#issuecomment-6194823973) | Ordered commits, shared ownership, backup, clear, recovery |
| [GitHub](github-collaboration.md) | [Choose GitHub collaboration and delivery contracts](https://github.com/kaneki003/code-review-workbench/issues/9#issuecomment-6195514149) | Read completeness, exact writes, receipts, merge/queue |
| [Investigation](ai-investigation.md) | [Choose AI runtime and investigation contracts](https://github.com/kaneki003/code-review-workbench/issues/10#issuecomment-6210330964) | Account/model lifecycle, owned tool loop, context and checks |

No independently installed background service, remote workspace support, source-editing agent or new review dashboard is selected. The [existing ADRs](../adr/) record the significant tradeoffs; this synthesis does not introduce another architectural alternative.

## Processes, modules and public boundaries

The local Node extension host owns the review manager and all privileged actions. Each webview is a disposable renderer. SQLite runs entirely in a packaged worker. Git is an asynchronous installed child executable. Later PDF extraction and contained checks use bounded owned workers/processes. The extension remains responsible for recovering after any of them stops; a closed window does not establish that a child or remote request stopped.

```text
src/
  extension.ts              # starts the extension and wires implementations
  application/              # operation coordination and host-owned state
  domain/                   # identities, contracts and pure rules
  git/                      # repository discovery, committed reads and checkout
  github/                   # normalized provider requests and responses
  storage/                  # SQLite, worker transport and persistence
  native/                   # existing native-helper probes, pending migration
  protocol/                 # browser-safe messages and validators
  vscode/documents/         # native documents, source links and saving
  vscode/views/             # native view integration
  webviews/drafts/           # draft browser entry, client and React view
  webviews/readiness/        # readiness browser entry and React view
tests/
  application/ git/ github/ storage/ native/ vscode/ webviews/
  host/                     # installed-VSIX runner and composed journeys
  provider/                 # separately authorized real-provider reads
  support/                  # reusable fixtures and child-process entry points
```

The owner accepted responsibility-based source and test grouping on 22 October 2026; the [code layout guide](../development/code-layout.md) describes the implemented organization. Create folders as behavior needs them. Domain rules import no VS Code, React, database or provider SDK. Application actions call their contracts; connections implement those contracts. Startup supplies the implementations explicitly. Native integration and React never reproduce eligibility or reconciliation rules. Provider SDK objects stay inside connections.

The names below describe public application contracts, not a framework to generate in advance. All external work returns explicit structured outcomes and accepts cancellation where meaningful. Cancellation must still report the actual known outcome.

| Boundary | Application-facing operations | Required result and limit |
| --- | --- | --- |
| Review storage | `readReview`, `saveReview`, `saveDraft`, `clearReview` | Account/repository/PR-scoped data or a normal SQLite busy/error result |
| Repository checkout | `read`, `enter`, `exit`, `clearRecovery` | Active/completed result or a bounded receipt with exact failed Git diagnostics |
| Review store | `loadReview`, `commitChanges`, `flushInput`, `prepareOperation`, `recordOutcome` | Expected-revision transaction and committed sequence; idempotent local request result; no transaction held across external work |
| Store maintenance | `backup`, `migrate`, `inspectRecovery`, `restoreBackup`, `clearReview` | Verified manifest/cutoff or explicit pending/failure; restore reconciles external intents and changes incarnation |
| Source access | `resolveRepository`, `captureComparison`, `readSource`, `searchSource`, `compareGenerations` | Exact immutable inputs, bounded pages and completeness; no arbitrary webview filesystem path |
| Workspace transition | `preflightEntry`, `preservePriorWork`, `installPrSource`, `syncSource`, `restorePriorWork`, `reconcileTransition` | Verified phase plus expected/observed repository facts; ambiguous outcomes retain recovery protection |
| GitHub reads | `resolveActor`, `resolvePr`, `discoverRelevantPrs`, `observeHead`, `readDiscussion`, `readPendingReview` | Normalized server IDs, scope completeness, freshness and access errors; not an empty list on failure |
| GitHub writes | Named comment/pending/review/merge actions; `checkDelivery`, `observeMerge` | `confirmed`, `rejected`, `conflict`, `unconfirmed` or `unsupportedTarget`; no generic HTTP tool or hidden write retry |
| Model connection | `connect`, `listModels`, `selectModel`, `streamStep`, `refresh`, `signOut` | Account/connection kind, authorized/tested capabilities, ordered events and actual terminal outcome |
| Investigation runner | `start`, `stop`, `retry`, `continueAttempt` | One request/user turn, separate attempts, context manifest and retained partial output |
| Tools/checks | `read`, `search`, `startCheck`, `readOutput`, `stopCheck`, `revokeGrant` | Scoped validated operation, actual source, grant generation, bounded output and known/unknown process outcome |
| Attachments | `import`, `extractPage`, `cancelExtraction` | Immutable original reference, digest, page/range provenance and explicit partial/unavailable status |

Shared storage uses SQLite WAL and short transactions from each window. It has no exclusive application-wide owner. Repository-changing commands are serialized only within the affected checkout by atomically creating its bounded receipt. A stale receipt is cleared only after explicit user-controlled Git recovery; the extension does not reclaim it from heartbeat, process identity or timeout evidence.

## Identities, revisions and schema

Use opaque IDs, not fixed-length Git hashes or display names. Every private record carries an owner and review scope. The host resolves a requested target through these identities rather than trusting names or paths from a view.

| Identity | Meaning |
| --- | --- |
| Account | GitHub host and immutable user ID; login is display/search text |
| Owner scope | Account identity or a stable local-only identity; sign-in never silently transfers local work |
| Repository | Local registration, canonical worktree, per-worktree/common Git directories and replacement-detection facts; separate clones are distinct |
| Review | Stable UUID and kind; an account's PR review also has unique host/base repository ID/PR number |
| PR generation | Exact inspected head, observed base tip, merge base and comparison method; latest remote observation and working checkout are separate |
| Local generation | Exact two selected commit trees and their fixed-commit or moving-branch selectors |
| Anchor/target | Review, generation/object, side, path, content/blob identity and range; thread ID when applicable; explicit PR target without fake line numbers |
| Operation/attempt | Stable local operation plus each actual attempt; immutable original actor/target/source and known effect |

Keep different kinds of revision separate:

- Store incarnation invalidates old connections after restore; ownership fencing invalidates stale owners.
- Review content generation invalidates old saves/streams after Clear. Source generation identifies inspected bytes and comparison.
- Row/draft edit revisions order a specific change. A save acknowledgment identifies the exact committed edit.
- Attempt configuration fixes its model/connection, guidance and relevant context versions. Staging a next-model preference does not invalidate the running attempt.
- Grant generation fences revoked command permission. Event sequence orders deltas within an attempt; it is not a durable database revision.

Initial relational schema groups, using numbered migrations and parameterized SQL:

| Tables | Key fields and constraints |
| --- | --- |
| `store_meta`, `migrations`, `request_results` | Schema/protocol, incarnation, committed sequence; unique local request ID and its committed outcome |
| `owner_scopes`, `accounts`, `profiles`, `repositories` | Stable IDs; unique host/user and one profile per account; no credential bytes |
| `reviews`, `source_generations`, `file_sources`, `anchors` | Review UUID/kind/content generation/revision; unique account PR identity; exact comparison facts; owner/review-scoped foreign keys |
| `navigation`, `checkpoints`, `checkpoint_files`, `reviewed_marks` | Order/filter/focus/return target; explicit human marks keyed by applicable comparison fingerprint |
| `concerns`, `suggestions`, `dismissals`, `evidence` | Stable underlying concern; category/impact, original sources, applicability and evidence-version dismissal |
| `turns`, `attempts`, `attempt_events`, `tool_activities` | Ordered visible conversation; separate retries/configurations/outcomes; sequenced deltas and bounded retained output |
| `contents`, `attachments`, `context_manifests`, `provider_projections` | Immutable owner/review content references/digests; extraction status; supplied/omitted material; versioned provider-compatible parts |
| `drafts` | Original target, body, edit/committed/row revisions, content generation and deletion barrier |
| `discussion_records`, `read_scopes`, `pending_reviews` | Server identity and observed state; timestamps/cursors/completeness; cache never overrides server authority |
| `operations`, `operation_attempts`, `receipts`, `grants` | Frozen chosen action, dispatch permission/phase and receipt; original actor; scoped permission/version/revocation |
| `clear_operations` | Content-free deletion barrier and retained nonsecret facts required to explain incomplete deletion |

Use composite foreign keys/uniqueness that prevent crossing owner/review boundaries. Immutable source/content rows are referenced rather than replaced in place. A source change adds a generation; it does not rewrite an older anchor. A payload edit creates a new operation/version. SQL column definitions may be elaborated in implementation; these ownership, uniqueness and revision rules are binding.

Atomic database changes include draft text/target/revisions, source-generation installation with progress/evidence reconciliation, publication receipts and Clear with its new content generation. SQLite cannot atomically commit a Git or network operation. Git checkout transitions therefore use a bounded repository-local receipt; missing outcomes are reported for manual recovery and never automatically replayed.

The [storage contract](private-state-storage.md) owns the canonical OS-user-home registry, per-user platform data roots, filesystem requirements, content layout, recovery sidecars, backup/migration protocol and deletion inventory. Use WAL, FULL synchronization, foreign keys, secure deletion and a bounded busy timeout inside the worker. Credentials stay in VS Code authentication/SecretStorage; profiles, backups and logs contain only nonsecret references. Unsupported driver/filesystem/ownership capability prevents unsafe work; it does not start another empty store.

## View protocol, saving and navigation

The versioned request envelope contains `protocolVersion`, `viewInstanceId`, `requestId`, `action`, owner/review identity and the expected store/ownership/content generations. A mutation adds the relevant row/edit/source/target revisions. Background results additionally identify their operation/attempt and configuration. Do not require irrelevant revisions on every read, and do not use a stale-presentation check to discard an actual external receipt.

The host validates a finite action union at runtime: primitive shape, identifiers, allowed target, bounds and expected revisions. The first attachment receives a fresh projection; updates carry an ordered host projection revision, and gaps request a fresh projection. Replies acknowledge a request and exact committed state or a typed failure/conflict. A closed/recreated view cannot create a new operation from a replayed old request. Host-pending input remains associated with its original draft even if another file becomes active.

Input limits begin at 1 MiB UTF-8 per draft/message, 10 MiB per raw attachment and 64 KiB transport chunks. Assemble and validate a complete edit before commit; incomplete chunks cannot replace a saved value. Oversize/failing saves retain visible input and a copy/recovery path, never a silently shortened Saved value.

```text
editing -> Saving -> Saved(exact committed edit revision)
                 -> Failed(original text/target retained) -> explicit Retry
Close/Escape -> flush newest edit -> acknowledgment -> close and return focus
                                 -> failure -> keep writer open
Discard -> deletion revision -> delayed old writes rejected
view hidden/disposed -> host-received input keeps saving; no implicit Exit
```

Schedule writes about 300 ms after idle and no later than one second into continuous pending typing; disk completion may take longer. A late revision-4 acknowledgment cannot label revision 5 Saved. A crash may lose unacknowledged text. Persist user turns before inference and retained partial/final attempt output through the same ordering rules.

Source documents use revision-specific URIs resolved by the host. Native diff inputs identify exact comparison sides. Working files remain ordinary files; dirty buffers are not called committed source. Navigation return stores the original anchor, concern, expansion and focus target. Unavailable/renamed/deleted sources explain their real status rather than opening a convenient current line.

Keep native anchored reading and the approved bottom composer. Preserve Figma styling/control hierarchy, Context/Chat, native tabs and the ordinary generated Markdown overview. PR-level discussion, review summaries and unavailable-source threads use that overview. Safe generated action links carry allowlisted record identities, separate from untrusted author/comment Markdown. Do not restore the removed Review activity page. Views can move/hide; commands and submit/exit access remain reachable.

## Entry, source Sync, resume and Exit Review

### Real PR entry

1. Check local desktop environment and Workspace Trust. Resolve the GitHub actor, base repository/PR and explicit local registration. GitHub authentication initially requests the accepted `repo` scope; milestone-one application actions are read-only, but that OAuth grant itself is broad.
2. Save relevant dirty documents through normal VS Code saving; cancellation or failure stops entry before Git mutation. Refuse another active/interrupted receipt in the same checkout without blocking other repositories.
3. Record the original branch/exact commit and target in a bounded repository-local receipt. Run ordinary `git stash push --include-untracked` when status is dirty and record the resulting stash object without constructing a parallel file/index manifest.
4. Read/fetch the exact PR objects, then run `git switch --detach <head-oid>`. If Git fails, stop and show the repository, redacted command, exit code, stdout and stderr. Do not run an automatic rollback or recovery command.
5. Render the exact inspected generation, overview and changed-file navigation. AI and publication are not entry prerequisites. Normal resume checks source automatically; inaccessible updates retain labelled downloaded code and notes with Retry, without a false current-source claim.

Git transport is distinct from API login. The narrow initial route uses installed Git with the user's existing HTTPS credential helper or SSH configuration. On transport failure, explain ordinary Git setup/authentication and Retry. Do not promise that VS Code API sign-in configures Git transport or put tokens in argv, URLs or logs. Resolve fork PR heads through the verified base repository's PR ref into owned refs and compare the fetched object ID with API metadata. An automatic API-token-to-Git credential bridge is not implied.

PR comparison uses merge base to exact inspected head, retaining observed base tip as well. Insufficient history, multiple merge bases or unavailable objects produce a comparison limitation. Existing user branches, other worktrees, stash ordinals and remote names do not establish ownership. The [Git contract](git-source-lifecycle.md) supplies preflight and unusual-repository fallbacks.

### Review lifecycle

```text
inactive -> entering(preflight -> preservation -> source install -> activation)
         -> active(current | newer available | freshness unknown | no-switch reading)
active -> syncing -> active(new verified generation)
                 -> prior generation retained | transition recovery
active -> exiting -> preserve review-time edits -> restore prior branch/work/layout
                 -> inactive(verified completion) | restoration recovery
interrupted phase -> reconcile actual facts -> safe continue/restore or blocked recovery
```

Ordinary source edits during PR review save normally. Leaving/updating a dirty PR checkout offers the accepted stash-and-exit/stash-and-Sync versus stay/keep choice. These edits get a **separate named ordinary Git stash**, not the stash protecting prior work, and are never automatically replayed onto prior work or newer PR code. This is not a per-edit backup feature.

Exit asks VS Code to save dirty documents, switches to the recorded original branch or exact detached commit, and applies the recorded stash with `--index`. Drop the matching stash entry only after a successful apply. Git command success defines repository restoration; the extension does not verify a parallel manifest or restore tabs/layout/selections. Any failure retains the stash and receipt, reports the exact Git diagnostics and leaves recovery to the user.

During active review, new commits produce a notice, not a checkout. Explicit Source Sync waits for owned checks to finish or be confirmed stopped, preserves dirty edits by the selected path, revalidates real repository facts, installs exact new inputs and transactionally reconciles saved state. Keep unaffected human marks/routes/dismissals; clear changed-file marks; preserve original draft anchors/conversation; flag affected/uncertain evidence. A head change alone does not reset everything. Old callbacks cannot certify new source.

Discussion refresh independently updates paginated server records/completeness. Repository/list Sync reports per-PR updated/unchanged/deferred/failed/unknown results and updates inactive source without sequential checkout or focus changes. Each repository/window keeps at most one active review; other repositories may proceed concurrently.

### Local committed comparisons and clearing

Local comparisons resolve fixed commits or moving branch selectors and compare the two committed trees directly without changing checkout. Read those commit objects even when working files differ. Saving/staging edits does not update the comparison; commit further work and Sync. Resume refreshes moving branch selectors safely; fixed commits stay pinned.

Local-comparison Exit performs no Git rollback unless an actual entry transition was recorded. Association with a later verified PR remains in MVP, but its interaction, canonical history/transfer, duplicate/conflict and anchor cases are explicitly owner-deferred until implementation. Keep identities/provenance and gate association until those decisions are made; do not invent automatic history merging.

Clear is separate from Exit. Delete private notes, attachments, drafts, progress and derived caches while leaving the active committed comparison readable from its exact Git objects. Keep refs needed for that active comparison/recovery and release only unused refs for cleared history. Actual files, staging, protective stashes, profiles and GitHub records stay intact. The former [private-snapshot clearing question](https://github.com/kaneki003/code-review-workbench/issues/15) is out of scope because the owner removed the only review mode requiring those non-Git source copies.

Implement the existing clear-generation barrier, all-managed-copy cleanup, backup/WAL/content verification and disclosed minimal recovery remainder. A late save/AI event/backup cannot resurrect deleted history. Failures remain Clear pending with Retry. Clearing never replays an external effect or silently selects newer code.

## GitHub collaboration, delivery and merge

GitHub owns permissions, actual pending membership, published discussion and action outcomes. Normalize full paginated reads with independent scopes: list, discussion, own pending review and current head each have freshness/completeness. Partial GraphQL errors do not become proven absence. Refresh on entry/resume, explicit action, focus return and confirmed local mutations; use the accepted focused/unfocused cadence, conditional reads and rate-aware backoff without changing source.

All mutations are explicit human actions. Flush the selected input, validate actor/target/revision and persist the exact frozen payload before dispatch. The composer shows original source/PR/thread and final Markdown/preview. Other drafts, private Chat and unselected suggestions stay excluded. Retire only the exact sent draft revision; later typing survives an older receipt.

```text
local input -> preparing -> ready(intent durable, dispatch not permitted)
ready -> dispatching -> confirmed | rejected with proven no effect
                    -> delivery unconfirmed -> check receipt
check receipt -> confirmed | proven no effect | still unconfirmed
proven no effect -> deliberate new attempt under the original intent
```

Disable hidden write retries. Local request deduplication does not create remote exactly-once delivery. Read known IDs first; otherwise evaluate complete applicable actor/target/source/body/known-ID evidence. Matching text, a missing result, 404 or elapsed time is insufficient alone. Unconfirmed intent remains blocked against resend and dependent operations; independent reading/actions can continue. A restored backup reconciles external intents instead of dispatching them.

Use the [GitHub endpoint table](github-collaboration.md#request-and-receipt-contracts): REST issue comments, immediate source comments/replies, review lifecycle and guarded direct merge; GraphQL threads/pending additions, resolve/reopen and guarded enqueue. Source comments retain explicit source attribution. PR-wide Reply includes an editable visible link to the original; it does not invent GitHub nesting.

Finish review includes **all actual pending server comments**, visible summary and an explicit Comment/Approve/Request changes selection. Removing one requires confirmed remote removal. Reread body/state/membership before mutation; changed previews require a fresh human choice. An older pending batch after Sync must explicitly be submitted as Comment or discarded before a separate fresh decision review. Do not repin/recreate it automatically. Freshness checks gate Approve/Request changes/Merge; no AI/test/all-files gate is added. The accepted last-second content/head races remain accurately attributed after confirmation.

Merge is a separate composition and operation. Direct REST merge supplies inspected `sha` and chosen enabled method; required queue entry supplies `expectedHeadOid` and `jump:false`. Unknown affected-PR/stack scope stops the action rather than selecting an async route that may expand it. Queue entry is not Merged; observe eventual PR status and retain unknown outcomes. Submission/merge never automatically exits or restores work.

## Investigation, credentials, tools and limits

Enable the personal-local ChatGPT connection only after real authorized setup/inference and installed-runtime fixtures. The accepted plan uses app-owned browser sign-in, protected remembered registrations/tokens, serialized refresh and validated identity/permission. The host runs a small Responses/tool/result loop; no embedded Codex agent runtime or application inference proxy is selected. Use the route-specific builder and terminal-event handling in the [investigation contract](ai-investigation.md). API-key transports remain separate, deliberate connections with separate billing and model availability.

The model selector remains available throughout review. An attempt fixes its actual model/configuration; selecting another sets the next attempt and retains the same canonical review conversation. Show running/next models; Stop then Retry can redo the current question. Never silently switch provider, account, model or billing. One model investigation and one owned command run at a time; queue explicit questions and coalesce obsolete file-orientation work.

```text
queued -> preparing -> streaming <-> running tool / waiting for permission
                    -> completed | failed | bounded/partial
active -> Stop requested -> stopping -> stopped | outcome unknown
failed/stopped/partial -> Retry/Continue -> new attempt, same original request
host restart -> interrupted/unknown; no automatic inference/tool replay
```

Save the user turn before work. Stream ordered events with retained partial text, context/source/configuration attribution and actual terminal result. Stop blocks new dispatch immediately but cannot promise server computation/cost or child effects ceased. Source Sync waits for confirmed check settlement; fence model-only work at source transition. Reopening a view resumes display, never generation.

Context prioritizes the current change/question, same-review decisions/history, guidance, relevant exact-source code/discussion and attachments. Instruction precedence is current review, relevant repository guidance, then the single account profile. Record supplied/omitted/summarized/outdated material and guidance versions. Keep original local history and complete tool-call/result groups; provider-specific continuation parts use versioned projections and do not cross providers. Retrieve another PR only on explicit reference and verified access.

Tools are finite and host-owned: exact-source metadata/read/search, guidance, discussion, attachment text, explicitly referenced PR material and bounded owned checks. Source links/ranges are validated. Suggestions retain underlying concern, category/impact, observation/hypothesis/evidence/limits and dismissal provenance; file-entry assistance is incremental. AI examination never sets human Reviewed marks or certifies unvisited files. Adopting a suggestion opens private composition, not a publication tool.

Text/code/Markdown and PDF text keep immutable originals under storage bounds. A cancellable local extractor returns page/range provenance and partial/encrypted/image-only/unavailable status; no OCR or silent image upload. Select/pin the extractor against fixtures during implementation as already allowed by the investigation contract.

Initial owned checks use MXC plus a fixed packaged launcher with structured executable/argv/cwd input, clean per-run home/scratch and a minimal credential-free environment. The Pseudoterminal displays owned execution; it does not reuse user terminals. Validate grants immediately before launch; revocation fences queued work and stops affected running work where possible. Deny unsupported containment instead of falling back to the host. Manual network/setup/unsupported commands remain ordinary user terminal work, with no invented captured result.

The [execution platform table](ai-investigation.md#offline-command-execution) is an additional capability gate: macOS 15+ offline containment excludes host localhost; Linux requires suitable bubblewrap/user namespaces; Windows requires the documented serviced builds/stdio and proof that host-ACL fallback cannot occur. Prove socket/named-pipe/credential-broker isolation before enabling any lane. These restrictions do not disable supported manual review/chat/GitHub paths.

Starting bounds are inherited, not benchmark claims: 64,000 model-input token target below actual model capacity; 64 KiB retained answer; 8 model requests/16 tool calls/5 active minutes; 30-second first-event and 90-second idle targets; 64 KiB source pages/100 search matches; 256 KiB extracted text and 200 PDF pages per 30-second pass; one 2-minute owned check with 1 MiB captured combined output. The API path adds at most 8,000 output tokens per supported step; the plan route omits unsupported output-limit fields. Apply 1 MiB event-buffer/64 KiB tool-argument bounds before tool dispatch. Limits preserve complete-code-point prefixes and explicit partial status; Continue adds a deliberate attempt, not a hidden loop.

## Build, APIs, packaging and supported environments

These are inherited bootstrap pins checked by earlier decisions on 15–16 October, not newly installed or revalidated versions. Resolve the real dependency tree, commit `pnpm-lock.yaml`, use frozen CI installs and upgrade deliberately. Development Node is distinct from the embedded extension-host runtime.

| Area | Initial selected constraints |
| --- | --- |
| Host/development | `engines.vscode: ^1.141.2`; Node `>=24.15.0 <25`; pnpm 12.11.2 |
| Recorded host runtime | Selected VS Code releases: Electron 43.7.7, Node 24.21.0, Chromium 150.0.7871.250; record actual installed values |
| Language/types | TypeScript 7.0.2; `@types/vscode` 1.140.0; `@types/node` 24.19.2 |
| UI/build | React/React DOM 19.3.1, types 19.3.0; Tailwind/CLI 4.3.3; esbuild 0.28.2 |
| Fast tests | Vitest 5.0.4; Vite 8.3.4; Testing Library React 16.3.3/DOM 10.4.2; jsdom 30.1.3 |
| Desktop/package | test-cli 0.0.15; test-electron 3.1.0; Mocha 11.7.6/types 10.0.10; vsce 4.0.0 |
| Git/GitHub | Git >=2.23 capability target; Octokit 5.0.5; REST header version `2026-03-10`; fixture-checked GraphQL schema |
| Database | Host built-in `node:sqlite` in packaged worker; accepted release-candidate driver gate; no silent driver replacement |
| Direct ChatGPT | `openid-client` 6.8.8; `openai` 7.34.0; plan-specific auth/catalog/Responses projection |
| Parallel APIs/checks | `ai` 7.0.141; OpenAI adapter 4.0.93; Google adapter 4.0.96; Zod 4.1.8; MXC SDK 1.0.0 plus native closure/assets |

Declare local UI extension kind and no browser entry. Reject remote SSH/WSL/Dev Containers/Codespaces/tunnels, virtual/nonlocal workspaces and browser-hosted VS Code before private-state or repository operations. Opening local UI does not make a remote repository supported. Require Workspace Trust through the host mechanism and recheck at privileged actions.

Bundle the host as CommonJS targeting Node 24, externalizing VS Code/Node built-ins; deliberately validate ESM auth/runtime imports. Bundle browser code for the recorded renderer target, compile Tailwind with semantic VS Code tokens and no broad Preflight reset, and ship all scripts/styles/assets under a restrictive CSP/resource-root policy. Render untrusted Markdown/text safely; CSP alone is insufficient. No provider credential, arbitrary command URL or generic network tool reaches React/model tools.

Run the explicit pnpm build before vsce packaging, with the architecture's prepublish-hook handling and committed dependency-build permissions. If using `--no-dependencies`, copy every external runtime dependency/worker/native asset and license notice. Inspect the installed VSIX and run outside the source tree; a development-host import is insufficient. No production development server/CDN is required.

Target Windows x64, Linux x64 and macOS arm64, each at minimum and current stable VS Code; record OS/architecture, host, embedded Node/renderer, Git and enabled capability versions. Other architectures/remote hosts require deliberate additional coverage. Advertise only verified combinations. A failing required runtime/API/visual boundary returns its concrete mismatch for decision rather than silently substituting a mechanism or weakening behavior.

## First working milestone: local PR review with a saved draft

### Narrow runnable path

The accepted first end-to-end path uses a trusted local **single-folder repository already cloned**, one explicit GitHub.com PR URL, a verified account with PR read access, configured installed-Git transport access, an existing writable canonical private store and a supported packaged host. This narrows the milestone's entry route, not later MVP support. It avoids making AI, full PR discovery, clone/folder handoff or publication prerequisites for proving the core loop.

1. Launch the installed VSIX, paste the PR URL and select the existing local registration. Resolve the real PR/account and exact local source. Start from staged, unstaged and nonignored new prior work as well as a clean repository.
2. Save documents, stash prior work with ordinary Git when needed and enter the exact PR commit detached in the same folder. Show metadata/author description and every changed file; absent AI summaries are labelled unavailable rather than fabricated. Ordinary source/diff navigation works.
3. Select an exact old/new source range, open the usable bottom writer and type real local feedback. Saving/Saved/Failed refer to real durable commits. Close and reopen through the tagged original anchor; no GitHub pending record is created.
4. Hide/recreate the views and reload/restart the host. Resume saved target/text/navigation, inspect the repository/journal and attempt the required latest-source check. Unchanged source resumes directly; new source follows normal preservation/reconciliation; unavailable updates retain labelled old source with Retry.
5. Explicitly Exit Review. Save documents, switch to the original branch/detached commit and apply the recorded stash with index restoration. A failed command exposes its real diagnostics and receipt for manual recovery; editor view state is not reconstructed.

Use no model connection or GitHub mutation in this milestone. GitHub sign-in may still have the accepted broad scope; read-only describes the actions exercised. Setup of missing repositories, complete relevance discovery, local-comparison entry, full discussion, profile/attachment UI, AI, checks, publication and merge follow below. Incomplete milestone actions must explain their status rather than present success or an invented destination.

### Acceptance evidence

| Check | Observable pass condition |
| --- | --- |
| Installed bootstrap | Worker/SQLite/guard and canonical-root probes pass; actual runtime versions recorded; unsupported environment fails before mutation |
| Real source | Authorized disposable public/private/fork PR reads map to the correct base PR and exact fetched comparison; no API-sign-in/Git-auth conflation |
| Preservation | Ordinary stash/switch/apply restores staged, unstaged and nonignored new-file work; unrelated stashes and ignored files remain untouched |
| Real writer | Type, edit during in-flight save, Close/reopen, hide/recreate/reload and failed-save Retry preserve original target and latest acknowledged text; no mock Saved state |
| Native navigation | Correct sides/ranges/revision in ordinary split/unified diffs; renamed/deleted/unavailable targets stay truthful; source-link return restores source/concern/focus |
| Resume/Sync | Head/base/force-push change and failed-update check retain accurate inspected source, original drafts and changed/unchanged progress rules; no silent active checkout |
| Interruption | Failed checkout/apply retains the bounded receipt, stash identity and exact Git diagnostics; no command is automatically replayed |
| Coordination | Different repositories/windows proceed concurrently; a second window is refused only for the same working checkout |
| Exit failures | Moved branch, conflicts, missing objects or Git errors never appear as completed Exit; the user receives ordinary recovery facts |
| Host experience | Keyboard/accessibility/focus, light/dark/high-contrast, narrow/zoom, moved/hidden views and bottom-writer Figma layout checked on each advertised target |

The minimum proof path does not excuse omitting a destructive-transition guard. Unsupported unusual Git states must take the documented safe fallback before mutation. Use synthetic/disposable repositories for failure injection and separately authorized fixture PR access; this planning document does not authorize testing checkout against a user's unfinished work or posting fixture feedback.

## Dependency-ordered implementation slices

These are behavior/validation boundaries for later implementation tickets, not a duplicate issue tracker or calendar estimate. Each slice ends with an observable installed behavior. The referenced contract fixture suites remain binding; passing one happy path does not waive relevant fault checks.

| Slice | Working behavior | Dependencies and validation |
| --- | --- | --- |
| S0: installed host and private-state foundation | Installed VSIX shows environment/capability status, opens the packaged worker and demonstrates real saved/reopened synthetic input under one owner | Select/document/prove guard and durable sidecars; resolve lockfile/build; canonical root, failed commits, request fencing, migration/newer-schema refusal and basic recovery; no repository mutation until these pass |
| S1: first working milestone | Real existing-local PR -> native diff -> anchored draft -> resume/Sync -> verified Exit | S0; implement exact identities, journal, preservation and usable approved writer together; run the acceptance table above across minimum/current platform cells |
| S2: complete manual entry and private lifecycle | Relevant repository-filtered PR list/statuses, clone and workspace handoff, inactive/batch Sync, local committed review, real resume/clear/recovery | S1; cross-root/multi-root/save-hook/folder/crash fixtures, exact commit comparisons, all-managed-copy deletion and verified backup restore; linking stays gated for its owner-deferred implementation discussion |
| S3: manual GitHub collaboration | Complete attributed discussion, immediate/pending feedback, Finish review, Check delivery and separate permitted direct merge/queue | S2; REST/GraphQL route fixtures, actual pending membership, competing clients, old-source/old-batch behavior, durable uncertainty and authorized provider receipts; each write capability remains disabled until its own fixture passes |
| S4: personal-local investigation and context | Real permitted ChatGPT-plan sign-in/inference/model selection, continued questions, orientation/routes/suggestions, profile and text/PDF attachments | S2/source and read-discussion contracts; may proceed alongside independent S3 work; prove eligibility assumption/actual authorization, auth/refresh, tool round trips, bounds, source citations, Stop/Retry/Clear and provider projections; API support is parallel and explicitly distinct |
| S5: owned offline verification | Inspectable/revocable grants, contained checks, truthful terminal/output/Stop and source-Sync coordination | S4 runner plus S1 transition rules; prove each OS's real containment/IPC/credentials, argv and descendant outcomes; unsupported lanes remain manual under the accepted exception |
| S6: complete-MVP and public-release reconciliation | Full PRD/design journeys and supported public provider setup with verified package/platform behavior | Integrate S2–S5 and later-PR association after its deferred design; obtain provider answers and resolve the separate public-release design review; verify final runtime/model/permission, accessibility, preservation and recovery fixtures before public claims |

An implementation failure that requires a changed contract creates a precise decision blocker before that feature proceeds. A failed fixture is not permission for automatic JSON fallback, unsafe takeover, uncontained execution, weaker merge guards or account-to-API substitution.

## FR01–FR20 trace and interface coverage

S1 is deliberately partial product coverage. “Later” below identifies the completing slice, not removal from MVP. Native/renderer acceptance applies across slices.

| Requirement | Responsible components | Milestone coverage | Observable completion check |
| --- | --- | --- | --- |
| FR01: open selected changes safely | Manager, Git/GitHub/storage, entry/navigation | S1 URL/existing-local PR; S2 list/clone/local committed comparisons | Correct relevance/status filters; committed source only; saving/staging cannot change inspected source; verified preservation/restoration; failed clone cannot become remote-only review; local work has no invented PR destination |
| FR02: provisional opening explanation | Runner, source/context, overview | S4; S1 metadata is usable without AI | Description/code-grounded explanation, disparities/limits and inspectable sources; no invented requirements or automatic approval |
| FR03: optional route and human progress | Rules, manager/store, navigation | S1 all-files/manual marks; S4 generated route | Ignore/reorder checkpoints with mouse/keyboard/agent while all files remain accessible; reading/AI never marks Reviewed; Sync retains only applicable marks |
| FR04: source navigation and orientation | Native documents/comments, source, runner | S1 exact source; S4 file orientation | Actual side/path/range/revision, related-source return/focus; native search/navigation fallback; unavailable target never opens an unrelated line |
| FR05: complete accessible discussion | GitHub, overview, native threads | S3 | Paginate comments/reviews/nested replies and own pending separately; attribution/status/limits correct; other private pending records not exposed |
| FR06: independent discussion refresh | GitHub read queue, manager, context | S3; S4 context/deduplication | Replies/edits refresh without checkout; partial/access/rate failures visible; existing concerns link discussion with attribution |
| FR07: deliberate selected feedback | Composer, manager/store, GitHub | S1 durable local draft; S3 publication | Only final visible PR/file/range/suggestion text goes to accurate destination; invalid anchors retain input; private Chat/other drafts excluded |
| FR08: replies and permitted edits | GitHub, native/overview, composer | S3 | Original thread/ID family preserved; PR-wide link visible; own edit/delete/resolve capability checked; refusal retains recoverable input |
| FR09: incremental suggestions | Runner, rules/store, native/UI | S4 | File-entry pace, category/impact/evidence/limits, stable underlying concerns, editable impact/text, deduplication and dismissal/resurfacing provenance |
| FR10: explicit review decisions | Finish UI, manager/store, GitHub | S3 | Actual pending membership/preview, unchosen decision, accurate fresh-source gates and older-batch flow; no mandatory AI/test/all-files completion |
| FR11: separate permitted merge | GitHub, manager, merge composition | S3 | Known/unknown policy shown, inspected-head guard, selected-PR scope; queue receipt differs from merged; no bypass or automatic Exit |
| FR12: truthful remote outcomes | Durable operations/receipts, GitHub, UI | S3 | Failure/unconfirmed/confirmed remain distinct through crash/restore; no resend from absence; queued/pending is not Merged |
| FR13: inspectable context/attachments | Source, runner, extraction/store, Context | S4 | Text/code/Markdown/PDF-text sources and actual tool activity inspectable; original attachments survive partial extraction; omissions/unavailable material explicit |
| FR14: continuing same-review understanding | Manager/rules/store, source/context | S1 source/draft continuity; S4 full context | Retain unaffected history/progress and flag affected evidence; old checks/approval do not certify new source; other-PR retrieval requires explicit reference |
| FR15: optional focused commands | Runner/execution, grants/store, terminal | S5 | Actual scoped/revocable permissions, optional checks, ordinary terminals untouched, no extra blanket approval; unsupported/online cases clearly manual |
| FR16: actual check evidence | Execution/source/store, terminal/Chat | S5 | Output/exit/error/partial/interrupted/unknown and local-versus-CI retained; source fingerprint accurate; Sync waits for confirmed settlement |
| FR17: one personal profile | Account/profile store, setup UI, context | S4 | One editable account profile; review > repository > profile guidance; version/precedence explainable and no permission/fact override |
| FR18: local resume and clearing | Store/manager, source/GitHub recovery, UI | S1 draft/resume; S2 complete lifecycle | Acknowledged work/focus/filter/dismissals restore; clear private copies with disclosed minimal recovery while keeping active committed-source access; profile/repository/GitHub unchanged |
| FR19: supported cloud choice/fallback | Account/API connections, runner, setup/Chat | S4 interim local; S6 public providers | Actual plan-authorized inference, explicit supported models and switches; current/next boundary; no silent billing/provider fallback; manual/GitHub usable without AI |
| FR20: familiar accessible editor | Native integration and all React screens | S1 onward | Ordinary code/diff/terminal; keyboard/screen-reader/focus/contrast/zoom/narrow/moved-view checks; textual statuses; hiding assistant leaves review active |

The seven prepared Figma families do not prove local-comparison entry, general PR discovery, profile editing, attachment extraction, real provider setup/model selection, grant/revocation or merge composition. Build focused variants for those required flows within the existing surfaces. The written PR-wide overview amendment and current/next-model rule also need native implementation even though earlier frames omit them. Prepared autosave/stream/receipt/checkout states are simulations, not runtime evidence.

## Verification and remaining gates

Fast behavior tests cover pure reconciliation, scope/revision/dispatch rules and meaningful races. React interaction tests type actual input and exercise failure/Close/Retry and focus within owned components. Desktop integration tests exercise real APIs, documents, comments, moved views, workers and packaged assets. Fault-injected Git/filesystem/provider adapters test every durable boundary; real disposable repositories prove preservation. Authorized provider fixtures separately establish endpoint/auth/receipt/model behavior; a fake adapter cannot prove it.

Required cross-platform coverage includes save/disk-full/corruption/clear, concurrent different repositories, same-checkout refusal, failed Git commands with exact diagnostics, branch/base/head movement, database migration, uncertain remote delivery and model/check cancellation. Use the detailed fixture inventories in each owning contract. Run minimum/current Git/VS Code where specified and record exact supported cells, including manual accessibility/assistive-technology and Figma comparison.

| Gate | What is still required | Effect |
| --- | --- | --- |
| Coherent handoff | Owner accepted this plan, narrow S1 path, ordering and explicit limits through [Accept the technical design and first working milestone](https://github.com/kaneki003/code-review-workbench/issues/11) on 16 October | Complete for personal-local development planning only |
| Storage/source/native implementation | Concrete guard selection/proof, worker/driver/sidecar/restore/preservation and actual native visual/focus/accessibility fixtures | Blocks enabling affected mutation/capability, not permission to weaken the accepted contract |
| Personal-local AI integration | Actual route eligibility/authorization/inference, credential lifecycle, supported model/tool/event/installed-runtime fixtures | Blocks enabling the interim connection; non-AI S1 is independent |
| Owned commands | Actual packaged MXC policy, process outcome and credential/IPC isolation on each requested OS | Blocks that execution lane; accepted manual exceptions remain |
| Public ChatGPT eligibility | Provider answer for this proprietary private-source initially-free product; see [Establish ChatGPT plan-access eligibility for the proprietary extension](https://github.com/kaneki003/code-review-workbench/issues/12) | Public-release gate; owner reports request submitted, no answer established |
| Public Gemini eligibility | Supported consumer-plan integration/agreement; see [Establish Gemini plan-access eligibility for the proprietary extension](https://github.com/kaneki003/code-review-workbench/issues/13) | Public-release gate; no approved route or submission established |
| Public-release reconciliation | Incorporate both answers, exact authorized flows/models/quotas/packaging and fixture results in [Confirm the public-release AI design after provider eligibility answers](https://github.com/kaneki003/code-review-workbench/issues/14) | Separate design acceptance; overall map stays open until required decisions resolve |
| Later-PR linking | Owner-deferred interaction/history/conflict/anchor decisions during implementation | Gate association only; capability remains MVP |

The untested assumptions are explicit: the selected driver and dependencies load in the actual VSIX/runtime; a safe shared guard and sidecar protocol can be implemented on supported local filesystems; Git/host transitions preserve their declared states; selected GitHub routes and queue boundaries behave as required; the personal-local plan route authorizes this use and supports the required model/tool loop; and each enabled command lane actually contains credentials/IPC/network and establishes child outcomes. Evidence that contradicts one of these returns the precise contract for decision. Public provider eligibility cannot be inferred from a successful local login or API-key run.

Production code, real user-repository preservation tests, feedback publication/merge and public release are outside this planning effort. The accepted local handoff does not close the overall [technical-design map](https://github.com/kaneki003/code-review-workbench/issues/1) while its required public decisions remain open.

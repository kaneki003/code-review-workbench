# GitHub collaboration and delivery

Status: accepted planning contract, 15 October 2026. The owner confirmed shared understanding across both discussion rounds, including sign-in, refresh, conflicting edits, review-head/content race limits, conservative uncertain-delivery recovery, older pending reviews, PR-wide reply references and separate selected-PR merging. This document selects the integration and required validation; no integration or publication behavior has been implemented or tested.

Decision: [Choose GitHub collaboration and delivery contracts](https://github.com/kaneki003/code-review-workbench/issues/9), within [Plan the Code Review Workbench technical design](https://github.com/kaneki003/code-review-workbench/issues/1).

Read with the [PRD](../product/PRD.md), [design baseline](README.md), [extension architecture](extension-architecture.md), [Git/source lifecycle](git-source-lifecycle.md) and [private-state storage](private-state-storage.md). Their identities, ownership, save acknowledgments and restoration rules remain binding. Detailed local-to-later-PR linking remains owner-deferred to implementation.

## In plain language

Use VS Code's GitHub login and keep the GitHub connection inside the extension. A local draft stays on this computer. A GitHub pending review has already reached GitHub but awaits submission. Published feedback requires confirmation from GitHub. A connection failure can leave delivery unconfirmed; it must not silently become either success or a reason to post again.

Keep conversation beside its code when an accurate anchor is available. PR-level comments, submitted review summaries and unavailable-source threads appear in the already-approved PR discussion section of the ordinary Markdown overview. The existing bottom composer writes feedback; Context / Chat and the removed Review activity page are unchanged.

## Connection and maintenance boundary

Use the official Octokit JavaScript client in the host-only GitHub connection. REST handles PR metadata/search, issue comments, immediate review comments, review lifecycle and direct merge. GraphQL supplies review threads, nested replies, viewer capabilities, pending thread additions, resolve/reopen and queue entry. Both are GitHub APIs, not two application architectures. Keep their data types inside the connection and return normalized application records.

Start with `octokit@5.0.5`, commit the actually resolved pnpm lockfile at bootstrap and bundle its ESM packages into the CommonJS host through esbuild targeting Node 24. Its tagged manifest requires Node >=20; that is an engine match, not a completed package/load test. Do not introduce a second runtime or hosted webhook service. Do not enable a generic automatic retry for GitHub writes, including through SDK retry/throttling plugins. Safe reads can use bounded retry/backoff; uncertain writes enter reconciliation. An SDK correlation field such as `clientMutationId` is not an idempotency guarantee. [Pinned client release](https://github.com/octokit/octokit.js/releases/tag/v5.0.5), [tagged runtime/ESM manifest](https://github.com/octokit/octokit.js/blob/v5.0.5/package.json), [esbuild platform/output behavior](https://esbuild.github.io/api/#platform).

Pin REST requests to `X-GitHub-Api-Version: 2026-03-10`, accept the raw GitHub JSON representation, identify the extension through its user agent and validate the response fields used. Use Octokit's explicit route request when generated helpers lag a documented endpoint. GraphQL has its own evolving schema; check the selected queries against current official schema and fixtures before enabling a capability. Missing fields or partial errors produce incomplete/unsupported results rather than empty successful data. [API versioning](https://docs.github.com/en/rest/about-the-rest-api/api-versions), [Octokit](https://github.com/octokit/octokit.js).

The application-facing connection needs operations for verified account/PR resolution, relevant PR discovery, current-head observation, complete discussion/pending-review reads, one explicit feedback mutation, delivery reconciliation, merge eligibility and merge outcome observation. Give actions domain names such as `readDiscussion`, `addPendingComment`, `submitReview` and `checkDelivery`. Do not expose arbitrary HTTP requests or provider tokens to React or the model runtime.

## Authentication, access and repository mapping

Obtain consented sessions through `authentication.getSession('github', scopes, options)` and verify the actor through GitHub's authenticated-user endpoint. Key accounts by `github.com` plus immutable user ID; login is a changeable display/search value. The selected initial route requests `repo` for private and public collaboration. Its broad authority is accepted; it is not a read-only or repository-selected grant. Do not request email/admin/workflow scopes speculatively. Request extra organization scope only if a concrete required query needs it and after normal provider consent. [VS Code authentication](https://code.visualstudio.com/api/references/vscode-api#authentication), [OAuth scope definitions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

Listen for session changes and revalidate the actor before a mutation. Sign-out, token expiry or account switching fences undispatched old-account work; it does not retarget a draft, transfer private history, cancel an already-dispatched request or implicitly Exit Review. Reauthenticate the original account for its reconciliation. Keep credentials out of SQLite, recovery records, webviews, logs and AI tools. Git transport credentials remain a separate connection concern; an API token is not proof that a `git fetch` can authenticate.

Parse only supported GitHub.com PR URLs as candidates. Resolve owner/repository names to a server repository ID and verify the PR through that repository before registration. Preserve base repository identity/PR number, head/fork identity, exact source facts and local repository mapping separately. Remote aliases and matching branch names do not establish identity. Renames/redirects update display names only after verified resolution to the same ID; a replaced name must not inherit another repository's drafts. A fork PR's collaboration destination remains the base repository's PR.

Use the accepted canonical local Git mapping to select the checkout; when several local copies match, retain an explicit selected registration rather than guessing. A deleted/inaccessible fork does not imply deletion of its PR or retained source. Local-only review has no publication destination until the separately gated association workflow is implemented.

Treat 401 as authentication recovery; inspect 403/429 and rate/SSO headers to distinguish policy/access from throttling. A private-resource 404 can mean missing access, not proven deletion. Show the affected repository/operation, keep recoverable input and offer Sign in/Authorize organization/Retry/Open GitHub as applicable. Organization SSO/approval and current user permissions remain authoritative. Never switch accounts, downgrade a write into another destination or silently treat inaccessible data as an empty list. [Authentication failures](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api).

## Relevant PRs and independent refresh

Discover the account's relevant repositories from authenticated relevant-PR search plus retained/manual registrations, then query within the selected repository. Keep separate relevance reasons for author, assignee, mention, requested review including team requests, previously reviewed, manually added and retained personal work. Use `is:pr`, appropriate open/closed state and the documented `author:`, `assignee:`, `mentions:`, `review-requested:` and `reviewed-by:` qualifiers, union by immutable repository ID/PR number, then hydrate metadata. Recompute search login after a verified account rename. Do not substitute `involves:` for review-request semantics or expose every repository PR as the default feed. Include retained/manually added inaccessible PRs with a truthful access status. [Search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests).

Follow REST pagination links and every GraphQL connection cursor, including comments nested inside each thread/review. Use pages up to the documented 100-item maximum, bounded queued work and incremental rendering. Search's 1,000-result ceiling and `incomplete_results` require splitting by stable repository/date ranges where useful, deduplication, and an explicit incomplete status if coverage cannot be established. Search is a discovery index, not an authoritative current-head or delivery receipt. A capped API file/commit listing cannot certify complete source; the Git contract supplies exact local source evidence. [Search API](https://docs.github.com/en/rest/search/search), [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api), [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).

Discussion reads cover PR issue comments, submitted review summaries, review threads and all their replies, plus a separately represented own pending review. Query `reviews(author: currentLogin, states: [PENDING], first: ..., after: ...)` and paginate its comments; do not use `latestReviews`, which excludes pending reviews. Retain server IDs, raw body, author, created/updated/submitted times, original/current source fields, resolved/outdated state and available viewer capabilities. Other people's private pending records are not public discussion. A thread already obtained through two APIs is one record, not two comments.

Each read scope tracks `notLoaded`, `loading`, `completeAsOf`, `incomplete`, `failed` or `unavailable`, with observation time, errors and remaining cursors. Pending review, published discussion, PR-list metadata, current-head freshness and inspected source have separate scopes. GraphQL data plus errors only completes unaffected proven scopes; null data does not prove absence. Do not delete cached comments or claim no pending review because a page failed. Reconcile deletions only through a successful suitable read; retain original references and disclose uncertainty.

Refresh on entry/resume, explicit Refresh, return to window focus and after confirmed local GitHub actions. During active review, schedule discussion checks approximately every 60 seconds while focused and every five minutes while unfocused. Coalesce overlap; no background review polling after Exit Review or while the extension is stopped. Prefer conditional REST GETs and incremental change detection, periodically completing full relevant scopes to detect edits/deletions. GraphQL requires its own budget; a successful REST 304 does not validate unrelated GraphQL data. Honor `x-poll-interval`, `Retry-After`, reset times and bounded exponential backoff. No fixed-latency or atomic whole-discussion snapshot guarantee is made. [API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

Automatic discussion checks do not fetch/checkout new source or change anchors, Reviewed marks or explanations. A newly observed head only raises the Git contract's newer-source notice; deliberate Source Sync remains separate. A source-update failure does not erase accessible discussion; a discussion failure does not pretend the source changed. Provide visible last-check/incomplete/error information in the existing surfaces.

## Composition, inclusion and local state

The bottom composer identifies actor, PR and exact PR/file/range/thread target; source-bearing content also shows its actual inspected revision. Draft discovery includes PR-wide and reply drafts through existing navigation/overview actions, with a `Draft · saved on this device` label. Local draft text is not rendered as published PR discussion. The existing storage acknowledgments and Close/Discard rules apply.

At an explicit action, flush/save the visible input, validate its revision and capture an immutable exact payload. Later typing remains a newer local revision and is never cleared by an older receipt. Show the final raw Markdown and its preview, including any suggested-change block or reply link. Do not inject invisible deduplication markers, AI history, extra wording or attachments into publication.

| Action | Included and excluded content | Confirmation effect |
| --- | --- | --- |
| Comment | Only this visible PR comment/source comment/reply at the displayed target; other drafts and AI text excluded | Add the confirmed server record; retire only the exact sent draft revision |
| Start a review | The chosen source comment/reply and explicit pending review identity/source; no publication event | Link its confirmed pending IDs; local draft retires only for the acknowledged revision; published count does not change |
| Add review comment | Only this chosen source comment/reply in the identified existing own pending review | Add a confirmed pending record; recompute pending count from actual server membership |
| Edit/remove pending comment | The selected actual pending record; edit uses the visible replacement text | Change membership/body only after confirmed remote effect; unrelated drafts remain |
| Submit review | All actual displayed pending comments, visible summary, explicit Comment/Approve/Request changes decision and reviewed revision | Mark that review submitted only on receipt; clear only that review's pending membership and matching summary revision |
| Discard pending review | The explicitly identified own GitHub pending review and its comments | Delete the remote pending record only on confirmed effect; independent local drafts remain |
| Edit/delete published own feedback; resolve/reopen | The identified server object and explicit replacement/state action | Update that object on confirmation; never clear unrelated drafts or resolve autonomously |

PR-wide feedback can be an immediate issue comment or the visible review summary when submitting a review; it does not become a fake source thread. A standalone saved PR-wide draft remains local until explicitly published or adopted into that summary. Do not silently merge multiple drafts into a review body.

GitHub PR issue comments and review summaries have no native nested reply thread. Their Reply action composes a new PR-level comment with a visible permalink/quote to the original, which the reviewer can inspect and edit. Publish to the same PR conversation, label it accurately, retain the reference locally and do not claim GitHub provides parent-child nesting. Inline thread replies use the original native thread ID. If a parent disappears or access is lost, preserve input at its original target; offer an explicit new PR-comment composition rather than silently moving it. [Issue comments API](https://docs.github.com/en/rest/issues/comments).

## Request and receipt contracts

Every application mutation request carries `requestId`, a durable operation ID, actor/account, review/PR identity, store/ownership generation, action kind, exact target, visible input revision/body or explicit no-body action, inspected source where relevant and the expected last-seen remote body/state. The host resolves identities and checks current trust/ownership/access. A stale webview cannot create a new operation from an old message.

The connection returns one of: `confirmed` with normalized receipt; `rejected` with known no-effect evidence and recoverable input; `conflict` with the latest remote record; `unconfirmed` with dispatch/known-ID facts; or `unsupportedTarget` with the original draft. Successful HTTP alone is insufficient if required confirmation fields are missing. GraphQL mutation errors must be assessed alongside any returned object/effect. Record known effects even when another field failed.

A normalized receipt contains original operation/attempt/account/PR, endpoint and observation time, server object/review/thread IDs, URL where available, exact returned body/state, source attribution, and known changed membership. Merge receipts additionally hold the requested expected head/method/action, queue entry ID where applicable, result and confirmed merge commit when known. Never fabricate a URL or body equality when the endpoint did not return it; fetch the identified object when needed.

| Capability | Selected provider route and essential input/response |
| --- | --- |
| PR-wide comment | REST issue-comment create with `body`; record comment ID/URL/body/author |
| Immediate line/range or file comment | REST PR review-comment create with `body`, explicit `commit_id`, `path` and accepted side/range, or `subject_type:file`; retain actual source fields |
| Immediate inline reply | REST reply to the original root review-comment ID with visible `body`; verify returned original thread membership |
| Pending review creation | REST create review with explicit `commit_id` and omitted `event`; record review ID and PENDING state before adding children |
| Pending file/line/range comment | GraphQL `addPullRequestReviewThread` with explicit pending review ID, path, `subjectType` and applicable side/range; record thread/comment/review IDs |
| Pending reply | GraphQL `addPullRequestReviewThreadReply` with explicit original thread and pending review IDs; record membership |
| Own comment edit/delete | REST issue-comment or review-comment update/delete by the correct ID family; verify original author and last-seen body before dispatch |
| Own review-summary edit | REST update review with visible `body`; do not treat this as editing an old review decision or code attribution |
| Thread resolve/reopen | GraphQL resolve/unresolve by review-thread ID after capability check; record returned state |
| Submit/discard own pending review | REST submit by review ID with explicit `body`/`event`, or REST delete only while PENDING; retain submitted review ID/state/source or deletion evidence |
| Fresh review without a pending batch | REST create with explicit inspected `commit_id`, visible summary and chosen `event`; never inherit unrelated local drafts |
| Direct merge | REST merge with explicit `sha`, enabled `merge_method` and applicable title/message; record `merged`, merge commit `sha` and actual PR outcome |
| Queue entry | GraphQL `enqueuePullRequest` with selected `pullRequestId`, `expectedHeadOid`, `jump:false`; record returned `mergeQueueEntry` ID, PR/head/actor and state, then observe actual PR outcome |

Use nondeprecated line/range inputs. Suggested changes are visible GitHub suggestion-block Markdown attached to a valid source comment, not a local file edit. Validate eligible target/range and preserve exact replacement text; do not silently convert an invalid suggestion into ordinary prose. Current API fields must be verified in the chosen client/schema; an unsupported route retains the draft and stops that action. [Review comments](https://docs.github.com/en/rest/pulls/comments), [review lifecycle](https://docs.github.com/en/rest/pulls/reviews), [GraphQL PR schema](https://docs.github.com/en/graphql/reference/pulls), [suggested changes](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/commenting-on-a-pull-request).

Submitted reviews cannot be deleted through the pending-review delete endpoint. Offer permitted own summary editing, not a fictional submitted-review deletion or decision change through a body update. A missing delete capability explains the limitation while retaining independent local work.

## Pending reviews, competing edits and code versions

On entry/resume and before Start/Add/Submit/Discard, fetch the authenticated reviewer's actual pending review and all its comments. If none is proven, Start creates one; if one exists from another client, restore it and use Add. More than one apparent pending record, incomplete visibility or unknown previous creation requires reconciliation, not a second creation. Existing remote pending comments are never owned by this extension merely because it discovered them.

Start is a parent intent with separate create-review and add-comment child operations, each durably journaled. Confirming the empty pending review does not retire the local comment draft. If the subsequent addition fails or becomes uncertain, preserve the actual empty/partially populated review, the draft and the child receipt state; Retry never creates another review or repeats a confirmed child. Submit waits until every included addition/edit/removal is confirmed and the complete final membership is displayed. Discarding the pending review does not discard independent unsent local text. A known-ID deletion's definitive successful response establishes deletion; a later inaccessible or missing lookup alone does not.

Serialize cooperating local mutations and permit only one in-flight operation per dependent review/thread target. Before edit/delete/submit/discard, refetch and compare body/state/membership against the displayed snapshot. If changed, preserve local text, show both versions or the changed membership and require an explicit refreshed choice in the ordinary composer. Remote edits are not automatically overwritten or copied into a local draft.

The final review composition contains all actual pending server records. Excluding one requires an explicit confirmed remote removal; a local checkbox cannot do it. Reread immediately before submit, compare comment IDs/bodies, summary state, reviewed commit and permissions, and return a changed preview instead of sending if they differ. GitHub offers no documented atomic content-revision guard on pending-review submission or comment editing. Another client can still change the record after the last check. Record and reconcile actual returned/published content, flag any mismatch with the frozen preview and never silently label unseen content as exactly what was displayed. Exact inclusion is guaranteed for the extension's frozen request, not for concurrent writes made by another GitHub client.

An existing pending review's commit cannot be repinned through the documented update/submit input. After Source Sync, if that pending review is attached to an older commit, keep its accurate original anchors and allow submission as Comment. To Approve/Request changes on the newly inspected head, first explicitly publish the older batch as Comment or explicitly discard it; then compose a separate fresh decision review at the current inspected commit. Those are separate user actions with separate receipts. Never automatically discard/recreate/reanchor the old batch, send two reviews from one ambiguous action or label its old commit as the current one. The workbench offers Open GitHub and retains input if the provider rejects this path. Implementation must validate it with an authorized test PR before enabling it.

## Durable delivery state and recovery

Use the accepted SQLite plus recovery-record protocol. Before allowing network dispatch, durably store intent and the frozen exact payload in private storage plus the required independent recovery facts. If either required write fails, do not send. Advance to a dispatch-permitted phase durably before the request may leave the process. A crash after that point is potentially sent even if no response was recorded. Stop/navigation/account switching cannot turn a dispatched mutation into confirmed cancellation.

```text
local draft -> preparing -> ready (saved intent, no dispatch permission)
ready -> dispatching -> confirmed effect
                    -> rejected with proven no effect
                    -> delivery unconfirmed -> checking receipt
checking receipt -> confirmed effect | proven no effect | still unconfirmed
proven no effect -> explicit retry with a new attempt under the original intent
conflicting preflight -> updated composition; no dispatch
```

`ready` is retryable only when ownership/attempt facts prove no dispatcher could have sent it. Network timeout, disconnect, host crash, ambiguous 5xx or missing mutation response after dispatch are unconfirmed. Do not let Octokit, a restart, reopening the composer or clicking twice resend them. Deduplicate local request IDs and persist results; this prevents local duplicate dispatch, not duplicate remote effects in all circumstances.

Check delivery on recovery/return and through a visible Check delivery action. Read a known server ID first. Otherwise paginate the relevant actor's comments/reviews/pending membership, compare original identity, exact body/digest, target/anchor/commit and timing, and compare with pre-dispatch known IDs where available. Record ambiguous candidates. Repeated identical text, concurrent creation elsewhere, later edits/deletions, delayed visibility and partial/inaccessible reads prevent a unique match from being assumed solely from text or timing. A single empty page, a full search with no result, a missing pending review, 404 or elapsed timeout is not proof that nothing was sent.

Only a uniquely supported receipt or evidence of definitely undispatched/definitively rejected-without-effect permits leaving uncertainty. Otherwise show Delivery unconfirmed with Check delivery and Open GitHub. Preserve the original draft as locked recovery input, not a second sendable copy. Block resending that intent and dependent operations, such as submitting an uncertain pending addition; unrelated reading and independent eligible actions can continue. There is no override that turns an ambiguous outcome into safely retryable delivery. Finding the operation manually can supply a candidate server URL for verification; a user's assertion alone does not manufacture a receipt.

For known-ID edits, deletion or resolution, an accessible current target can establish its present body/state but not necessarily which client caused it. Distinguish `current target matches requested state; attribution unknown` from a proven original mutation receipt. A later different body/state is a concurrent change, not automatic evidence of failure. Do not retry destructive state changes merely because the desired state no longer holds.

Apply confirmed receipt, draft-revision retirement, pending membership and operation state together through the storage queue. If the host crashes after the remote effect or receipt-sidecar write, reconcile the known IDs before updating the private projection. Restored backups are reconciliation-only for old operations. Clear private data removes full bodies from all managed copies; retain only the storage contract's disclosed minimal account/target/operation IDs, digests and necessary source/receipt facts. If deletion removes evidence needed for unique matching, uncertainty can remain; never retain a hidden full draft or relax retry rules to compensate.

No general exactly-once or atomic all-GitHub-actions guarantee is claimed. The chosen contract is one deliberate dispatch, durable known facts and conservative recovery where the provider cannot prove an outcome.

## Source validation and endpoint-specific guards

Validate each source-bearing action against its actual original anchor, not a current file with the same path. Retain repository/head/comparison/blob/path/side/range evidence and verify that the provider route accepts that source. Replies continue the original accessible thread without inventing a current line. File renames, deleted lines, force-pushes, unavailable objects or rejected old ranges leave an actionable original draft. Offer deliberate retargeting or composing a clearly cited PR-wide comment; never silently move it.

Immediate REST source comments can explicitly carry an older `commit_id`; acceptance is endpoint-specific and rejection remains recoverable. The selected GraphQL pending thread-add input does not expose an independent commit selector: bind it only to a verified pending-review source and a validated compatible target. If an older anchor cannot be expressed accurately through that pending route, retain it and offer the accurate immediate-comment path or explicit retargeting; do not falsely put an old line on the current pending source. A stale pending review and a new-head draft cannot be mixed by assuming matching line numbers establish correspondence.

| Action | Required current/source check | Actual atomic guard and residual limit |
| --- | --- | --- |
| PR-wide Comment, summary-only Comment, existing-thread reply | Verify actor/PR/thread access and visible target; preserve cited source if any | No current-head prerequisite; no content compare-and-swap assumed |
| Source Comment/suggested change | Verify original source/accepted destination and range | `commit_id` attributes the comment; it does not require the PR's latest head to match |
| Approve/Request changes | Successful fresh head check must match inspected generation; detect base/comparison changes under Git contract; apply stale-pending rule | Creation's `commit_id` identifies reviewed code, not an expected-head check; pending submit has no head input |
| Direct merge through REST | Fresh inspected/head comparison, repository policy/method and known permissions | Explicit `sha` supplied; mismatch rejection is endpoint-specific; no unguarded fallback |
| GraphQL queue request | Same source/access checks; queue required/enabled status | Explicit `expectedHeadOid` supplied; later queue/rule processing is separate |

Check freshness immediately before dispatch, not solely when opening the composer. A failed freshness check disables Approve/Request changes/Merge while preserving local reading and permitted accurate older-code commenting. Newer unsynced source offers Sync now, without mandatory AI/tests/all-files gates. Dirty local/editor changes do not silently become the inspected PR commit.

After review confirmation, retain the actual server `commit_id` and check for a later head. If a push occurred in the gap, show the review as attached to its actual older source, flag the new source and do not auto-submit an updated approval. The owner accepted this unavoidable review-head race in the first round; acceptance does not waive the fresh check or permit a claim that unseen code was reviewed.

## Separate merge and queue lifecycle

Merge remains independent of review submission and AI. Read repository-enabled methods, user permission, open/draft state, conflicts/mergeability, checks/review requirements, rules and queue information where accessible. Present known blockers with provenance and observation time; missing policy data, ongoing calculation or inaccessible checks means eligibility unknown. Client hints do not override the provider's final decision. Authors still cannot self-approve where GitHub forbids it.

The ordinary merge composition names the exact PR/head and direct versus queue behavior. For a proven direct merge, offer an explicitly chosen enabled method (merge commit/squash/rebase) and applicable editable title/message. A queued merge uses the repository's queue strategy; do not promise a per-request method or title override that the endpoint does not support. Do not invent a universally preferred method, promise readiness from incomplete checks, submit a bypass, force a merge or offer queue administration/cancellation. Newer source stops the request and offers Sync.

For direct merge, use `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with explicit inspected `sha`, chosen enabled `merge_method` and applicable visible title/message. The documented endpoint excludes stacked PRs and merge queues. Treat a head mismatch/known rejection as rejected, not a reason to omit the guard. For a known required/enabled queue, use GraphQL `enqueuePullRequest` with the selected PR ID, explicit inspected `expectedHeadOid` and `jump:false`; persist the returned `mergeQueueEntry` ID and head/actor/PR/state. Do not expose a jump, bypass or administrative override. Query the actual target PR/entry through the same rate-aware read queue. A documented validation failure preserves composition; an uncertain result enters reconciliation.

Fetch `PullRequest.stack` and `stackEntry` in preflight; documented null values mean no stack only when the read succeeds without relevant errors. The async merge endpoint is deliberately not selected: it may include all open downstack PRs and offers no atomic allowed-PR-set guard; a preflight alone cannot prevent that expansion. A known stack or unknown affected-PR scope blocks the in-workbench merge request with a specific explanation and Open GitHub. Supporting a multi-PR stack action requires a separate owner scope decision. The selected direct endpoint's documented stack exclusion is stronger than an async preflight; the selected queue mutation documents one PR but does not explicitly promise stack rejection. Verify queue behavior in the authorized integration fixture; if it can expand the explicit enqueue target or cannot preserve that boundary, keep queue entry gated and return that concrete gap for decision. Normal repository queue processing of other independently enqueued PRs is not a request by this workbench to enqueue those PRs.

When queue requirements cannot be established, eligibility remains unknown and no route is silently guessed: refresh the missing policy facts or offer Open GitHub. Other incomplete checks can remain visibly unknown while a known policy-compatible action is offered under server enforcement. Unsupported selected endpoints stop the corresponding action; they do not authorize a switch to an unguarded or multi-PR route.

```text
merge composition -> dispatching -> confirmed merged | confirmed rejected
                               -> confirmed enqueued
enqueued -> observed in queue -> confirmed merged | removed/not merged | outcome unknown
dispatching -> request unconfirmed -> reconcile authoritative PR/queue state
```

While a request is in flight, show Request pending rather than Merged. A returned queue entry confirms enqueueing, not eventual merge. Observe the entry and actual PR merged state separately; queue disappearance alone does not prove merge or a specific rejection reason. A lost direct-merge response or queue entry ID leaves the request unconfirmed until actual target evidence resolves it. Actual PR merged state can confirm an eventual merge without proving this request caused it; retain that distinction. An absent queue entry after an interrupted request does not prove it was never queued: it could have merged, been removed or become inaccessible. Do not automatically resend a lost request.

Only authoritative merged status with the available merge commit/outcome confirms Merged. A policy rejection/failed result is reported specifically; an unknown result stays unknown. Keep separate publication and merge operation records. Submission, queue entry or confirmed merge never automatically exits the active review, deletes its drafts or restores the prior workspace. [Direct and async merge contracts](https://docs.github.com/en/rest/pulls/pulls), [queue/stack schema and mutations](https://docs.github.com/en/graphql/reference/pulls), [merge queue behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue).

The investigated async route has an operation UUID with pending/merged/enqueued/failed results and documented 24-hour receipt expiry; it is not a universal comment idempotency key and is not a selected recovery mechanism. GraphQL direct merge offers `expectedHeadOid`, but is not an automatic fallback either. Keep the selected REST `sha` and enqueue `expectedHeadOid` guards endpoint-specific: ordinary review submission has neither. Revisit a route deliberately if validation shows the selected route cannot satisfy the contract.

## Implementation checks before enabling collaboration

These are required future tests, not checks run by this planning discussion. Use fault-injected connection fixtures for the state machine and separately authorized disposable PRs for real provider behavior. The first milestone remains read-only GitHub access plus local diff/draft/resume/exit; publication/merge are later milestones.

| Fixture or injected fault | Required observation |
| --- | --- |
| Sign-in refusal, expiry, account rename/switch and two windows | Original actor/target and one-owner fencing survive; no wrong-account dispatch or private-state crossover |
| Public/private/fork PR, SSO and inaccessible/deleted fork | Correct base PR/local mapping; actionable access failure, no empty-success or invented destination |
| Multiple relevance categories, teams, reviewed history, manual/retained PRs, open/closed filters | Union/deduplication is correct and no all-PR feed replaces the personal list |
| More than 100 threads/comments/reviews and nested reply pages; search cap/incomplete result | All accessible pages load or exact incomplete scope remains visible; no false absence/deletion |
| Partial GraphQL data/errors, stale ETags, 403/429/reset/retry headers, offline/focus changes | Only proven scopes update; budgets/backoff respected and source checkout unchanged |
| Immediate PR/file/line/range feedback, suggestions and replies | Exact visible Markdown and correct ID/anchor family; no chat/unselected drafts included |
| Existing pending review from browser, pending edit/remove/discard, empty pending review | Actual membership restored/previewed; counts change only on confirmation and local drafts survive remote discard |
| External edit/delete/add/submit before and after preflight | Conflicts preserve both versions; last-second mismatch is disclosed; no overwrite/resubmit by assumption |
| Old pending head after Sync, older immediate anchors and incompatible pending additions | Accurate source gates and explicit two-review path; no automatic repinning or line-number guess |
| Push between check/send and send/receipt for each review/merge route | Review race stays accurately attributed; merge request includes explicit SHA and rejects mismatches as provider specifies |
| Failure/crash before intent, between recovery/DB writes, before dispatch and before/after every receipt save | No unjournaled dispatch; dispatched uncertainty cannot become a blind retry or premature draft/count clearing |
| Request accepted but response dropped; repeated identical text, missing IDs, delayed/partial reads, later edits/deletion | Receipt evidence is evaluated conservatively; no body-only deduplication or absence-based resend |
| Double click, SDK retry/throttling hooks, restart and backup restore | At most one local dispatch per permitted attempt; old intents reconcile instead of replaying |
| Clear private data during an uncertain send | Full local body removed from managed copies; only disclosed minimal recovery remains; uncertainty still blocks duplicate sends |
| Method/rule/check/permission changes, direct/required queue behavior, stack changes, guarded head mismatch, lost response/entry ID, queue removal and eventual merge | Known/unknown/pending/enqueued/merged/failed remain distinct; no bypass, jump, unsupported queue override, extra PR enqueue effect, weaker fallback or automatic Exit |
| Packaged minimum/current VS Code on supported OSes | Actual Octokit bundle/auth/schema/worker receipt routing works without a development server or credentials in webviews/logs |

Authorized integration PRs must specifically prove own-pending visibility, file/range/old-source acceptance and suggestion rendering, replies to published versus pending threads, own edit/delete/resolve/reopen permissions, old-pending-after-Sync handling, actual review content/head races and direct-merge/enqueue receipts and stack boundaries in repositories with suitable rules. If a field/endpoint does not behave as documented, keep that feature gated and bring the concrete mismatch back for decision; passing fake-adapter tests alone is not provider validation. No real feedback, test merge, rule bypass or fixture PR creation is authorized by this planning decision.

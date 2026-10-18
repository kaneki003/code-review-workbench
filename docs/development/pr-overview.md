# Verified PR overview (#19)

The command **Code Review Workbench: Open Pull Request Overview** accepts one GitHub.com PR URL in an existing trusted local repository root. It verifies the account and PR through GitHub, binds the selected local copy to immutable repository IDs, saves that candidate under the owning account, and opens an ordinary read-only Markdown document and preview.

This slice does not start an active source review. Checkout, downloaded source, diffs, discussion, AI, feedback publication, push and merge are unavailable. A configured GitHub remote identifies a potential local mapping; it does not prove that Git transport can authenticate or that PR source is already present.

## Walk through the implementation

1. [Extension commands](../../src/extension.ts) use one `ReviewManager` for readiness, opening, release and recovery. Input is retained for Retry. A newer command, workspace change or session change fences older work, including document attachment. During first-time consent there is no prior actor to fence; the returned credential must still pass `/user` verification. Authentication never releases ownership or performs Exit Review.
2. [Application records](../../src/application/pull-request.ts) hold normalized account, base/PR, head/fork and local-copy identities. [The manager](../../src/application/review-manager.ts) checks the host, inspects the selected folder, resolves metadata, verifies that the folder still matches, claims the store for the verified actor, and saves before presenting the overview. A different actor is blocked until explicit release. The same public interface reopens saved candidates for tests and later resume work.
3. [Local inspection](../../src/connections/local-repository.ts) reads the canonical worktree, per-worktree Git directory and common Git directory, including their device/inode identities. It reads raw Git remote configuration without executing a helper or contacting a remote. Only strict GitHub HTTPS/SSH coordinates survive; credential-bearing URLs are discarded. Git does not store GitHub's immutable repository ID, so remote names cannot prove clone origin on first use. First registration explicitly shows the selected path, verified server ID and PR for the user's confirmation. The overview labels that association as user-confirmed rather than claiming inferred provenance. Later saves check the retained ID/directory binding across all accounts; separate clones remain separate copies.
4. [GitHub reads](../../src/connections/github.ts) use `octokit@5.0.5`, the built-in VS Code `github` provider and the accepted broad `repo` scope. The connection captures one session, verifies `/user`, resolves the base repository, then verifies the PR against that immutable base ID. Head/fork identity is separate and can be explicitly unavailable for a deleted fork. Renames may change display names while retaining IDs. Every request pins REST `2026-03-10` and raw GitHub JSON. Credentials and SDK objects stay inside this connection.
5. [The store worker](../../src/connections/store-worker.ts) saves a normalized candidate in its existing transactional request-receipt journal. This reuses schema 1 without adding a lazy, unversioned table or a new migration. Each save advances the fenced durable revision and independent control record before acknowledgment. Reopening queries the last candidate by account scope, immutable base ID and PR number. Content-free local registration metadata is checked across account scopes so signing in as somebody else cannot bypass an existing directory/ID binding. A reused repository name or replaced directory cannot overwrite it. This is metadata persistence, not permission for a Git operation.
6. [Markdown generation](../../src/vscode/pull-request-overview.ts) uses `markdown-it@15.0.2` to preserve description structure with raw HTML escaped and all author links/images disabled, including reference-style links. The pin includes the parser's current performance/security fixes from its [official changelog](https://github.com/markdown-it/markdown-it/blob/master/CHANGELOG.md). Metadata is escaped separately. Only the host-generated, validated GitHub PR link is active. [The document provider](../../src/vscode/overview-documents.ts) supplies a generated `crw-overview:` Markdown document: normal editor typing is disabled, and closing the document drops its disposable projection without changing ownership.

The existing receipt journal retains older candidate snapshots along with the latest one. The later private-review Clear workflow must sanitize these receipts and all managed backups, just as it must for other saved private content. This slice adds no Clear or backup-restore UI.

## Failure and retry behavior

Sign-in refusal and 401 expiry return reconnect states; a retry after expiry requests a new VS Code session. Organization SSO/policy is distinct from private-resource 404 and throttling. A 404 is unavailable access, not proof of deletion. Missing or inconsistent response fields return incomplete metadata; a deleted fork/author is represented explicitly when GitHub confirms null.

SDK retry/throttling plugins are disabled. The connection allows at most three attempts per read, uses 250 ms/1 s backoff for transient failures, honors short server delays, and returns long delays to the user rather than retrying early. Each request has a five-second deadline and the network operation has a twenty-second deadline. Response assembly is bounded to 8 MiB; the saved author description is bounded to 1 MiB without truncation. At most sixteen GitHub remotes are considered. Consent itself is interactive and is outside the network deadline.

GitHub API failures retain their API recovery state. Local Git inspection failures identify folder/Git setup. The overview labels HTTPS-helper/SSH authentication as untested; this slice deliberately performs no fetch or credential bridge. No token is passed to Git, placed in a remote URL, included in a view/candidate, or logged.

## How to try it

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

Install `dist/code-review-workbench.vsix` through **Extensions: Install from VSIX…**. Open the root of an already-cloned, trusted local repository with a GitHub HTTPS or SSH remote. If this window already owns the anonymous private store from readiness experiments, run **Release Private Store** first.

1. Run **Open Pull Request Overview** and paste a PR URL for that repository or its fork.
2. Complete VS Code GitHub consent. On first use, confirm the displayed local path and verified GitHub repository ID with **Register Local Copy**. Cancelling saves no candidate. Expect the real title/state, actor ID, author description, base/head identities and user-confirmed local-copy information. A deleted fork is shown as unavailable. Normal typing in the generated document has no effect.
3. Close and reopen the PR. Expect the mapping to remain under the same immutable actor. Renaming a remote alias has no effect on identity. A name now resolving to another repository cannot inherit a prior registration.
4. Try an unsupported URL, inaccessible private PR, or interrupted API read. Expect an explanation and Retry, with the URL retained and earlier saved work intact.
5. Change accounts. Expect the original private identity to remain owned and a reconnect/release explanation. **Release Private Store** addresses that same owner; it is not Exit Review and performs no source restoration in this metadata-only slice.

## Verification and limits

`tests/github.test.ts` exercises the real pinned Octokit client against controlled HTTP/auth responses. It verifies wire headers, one-session reads, fork/base normalization, deleted resources, identity inconsistencies, refusal/expiry, SSO/policy/private 404, session changes and bounded actual transport retries. No fake SDK retry policy is used as evidence for the real client.

`tests/shared-store.test.ts` drives public manager actions with disposable real Git repositories and the production SQLite worker. Saved candidates are reopened through that interface, with no SQL side-channel assertions. Coverage includes stable registration, reused names, access loss, account isolation/release, first consent, stale targets, and unchanged files/index/refs. The inherited #18 ownership/recovery fixtures remain in the full suite.

Installed-host checks use a separately installed VSIX in a disposable profile, verify the built-in GitHub provider with a silent no-session read, open the native Markdown preview, and attempt actual editor typing. Malicious title/description/reference-link/image fixtures remain inert. This proves provider routing, packaged parser/worker loading and the read-only native surface; it does not prove interactive consent or live private/fork access. A bulk-edit API can intentionally alter a virtual model despite its read-only editor UI; that trusted extension API is not a user editing surface.

Live provider fixtures require separate authorization. Controlled public/private/fork responses are not evidence of real private-repository permissions, organization policy or an interactive VS Code login. Record those live checks separately without private bodies or credentials. Full keyboard/screen-reader inspection and the target platform matrix remain distinct from the bounded macOS automated checks.

On 18 October 2026, the owner separately authorized a read-only check of [PR #31](https://github.com/kaneki003/code-review-workbench/pull/31), choosing controlled tests for private access. The production Octokit connection successfully verified the actor, read repository ID `1420453141` and PR ID `4898532107`, read metadata/description and resolved the existing local remote. Base and head had the same repository ID, so this proves a public same-repository PR, not live fork access. The opt-in `pnpm test:provider URL` fixture obtains the already-authorized GitHub CLI credential only in memory; it is separate from product authentication and does not establish interactive VS Code consent. Output contains no body or token. Live private/fork access and interactive consent remain unverified.

Packaged macOS arm64 checks passed on VS Code 1.141.2 and 1.142.0 with embedded Node 24.21.0, Electron 43.7.7, Chromium 150.0.7871.250 and Git 2.56.0. The CI matrix re-runs the same fixtures on Windows x64 and Linux x64; those results must be inspected before claiming the corresponding cells.

The first PR #32 matrix run passed five cells but failed Windows/minimum before its packaged-host step. The existing host-death fixture waited only 2.5 seconds for a child that deliberately slept 1.5 seconds before starting Git; runner startup/Git latency could exceed the remaining margin. A controlled 3.5-second child reproduced the same `child-done` timeout locally. The fixture now gives child completion its own bounded ten-second wait, within the existing integration-test budget, and covers both delays. It still asserts that takeover is refused while the child runs and after it finishes. Production ownership, process and storage deadlines are unchanged.

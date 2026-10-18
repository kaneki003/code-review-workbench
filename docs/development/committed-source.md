# Inspect committed PR diffs (#20)

Open a verified PR overview, then run **Code Review Workbench: Inspect Committed PR Diffs**. The extension fetches the verified base repository's PR head ref and base branch into fresh workbench-owned refs. It checks both objects against the saved API metadata before publishing a comparison. Fork heads use the base repository's `refs/pull/<number>/head`, including when the selected local copy is registered to the fork.

This slice provides **no-switch reading**. Ordinary files and terminals stay on their earlier checkout. Source tabs read committed blobs, including when working files are staged, modified or unsaved. No source checkout, stash, working-tree review snapshot, GitHub feedback mutation or push is implemented. Checkout and later lifecycle/Sync work remain separate tickets.

## Walk through the implementation

1. **Public actions and exact identities.** [The manager](../../src/application/review-manager.ts) exposes source inspection, committed-file reads, explicit mark/unmark and navigation validation/save/read. [Source records](../../src/application/committed-source.ts) distinguish the exact head, observed base tip, actual merge base, comparison method, old/new paths, modes and blob IDs. A source ID names one immutable installation; file fingerprints include both sides and status, so a head-only or filename-only equality cannot retain a changed comparison's Reviewed mark.

2. **Intent before Git.** [The store worker](../../src/connections/store-worker.ts) saves the source plan in the existing account-scoped SQLite receipt journal and independently publishes minimal recovery facts. These contain source/object/ref and local-directory identities, not the author description or file list. A small digest binds the final immutable source record to its independent receipt. Large file sets therefore do not overflow the native helper's 64 KiB recovery-record bound. No new schema or unversioned source table is needed for this slice. A later Clear implementation must sanitize private source/navigation/mark receipts along with the earlier candidate receipts.

3. **Guarded fetch and retained objects.** Each side reuses the existing `prepared → armed → observed` native-child protocol in [repository operations](../../src/connections/repository-operation.ts). The independent record and SQLite projection precede dispatch. Fetches use installed Git and its configured credential helper/SSH access; API tokens never enter arguments, environment overrides, logs or recovery records. Hooks, recursive submodule fetches, tag fetching, configured ref mappings, `FETCH_HEAD` writes and automatic maintenance are disabled. The user branch, index and worktree are checked before/after. Fresh owned refs pin both commit histories, including old force-pushed source. Fetch has a 45-second observation deadline; uncertain/live processes keep recovery protection and block conflicting writes.

4. **Complete comparison, lazy content.** [Committed Git reads](../../src/connections/committed-git.ts) asynchronously compute all merge bases and a NUL-delimited raw local Git diff. They never use the capped GitHub files API. The exact merge-base/head comparison includes renames, deletions, modes and blob identities. Reading one side loads only that blob, with filters/textconv/external diff and lazy fetch disabled. Git replace refs cannot change inspected source. Missing, non-UTF-8, binary, LFS pointer, submodule and oversized content gets an explicit status. Shallow history or multiple merge bases cannot appear as a complete comparison.

5. **Atomic progress and original return targets.** Source publication and retained marks commit together. Opening a file, reading source and saving navigation do not set marks. Only an explicit mark/unmark action writes human progress. A changed comparison clears its mark; reverting to an older diff later cannot resurrect that cleared mark. Old-source callbacks cannot mark a newer installed comparison. Navigation stores source/file/side/path/blob/commit/range, editor control, column and focus. Range validation reads the original blob before an editor action, so an unavailable range cannot be clamped onto unrelated current code.

6. **Ordinary VS Code UI.** [The native tree and source documents](../../src/vscode/committed-review.ts) open `vscode.diff` with correct original/new inputs and revision-labelled read-only documents. The user's native diff control selects split/unified mode. A generated [overview](../../src/vscode/pull-request-overview.ts) lists every changed file with safely encoded exact-revision document links, separate from untrusted author Markdown. The native tree inherits theme, contrast, zoom, focus and keyboard behavior. **Return to Committed Source** restores the saved control, side and selected range; `Alt+Shift+Left` invokes it from committed documents. Closing or hiding views changes no repository state.

## How to try it

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

1. Install `dist/code-review-workbench.vsix` through **Extensions: Install from VSIX…** in a supported local desktop VS Code. Open the root of an existing trusted clone.
2. Run **Open Pull Request Overview**, paste a GitHub.com PR URL, sign in and confirm the selected local copy on first registration. Use the existing Git credential helper or SSH setup for transport separately.
3. Run **Inspect Committed PR Diffs**, or use the download action in the workbench's Changed Files view. Expect a visible no-switch statement and the exact head/base-tip/merge-base in the overview. Every changed file is directly available, regardless of language or API page size.
4. Select a changed file. Expect an ordinary native diff. Renames retain both paths; additions/deletions have an intentionally empty absent side. Use VS Code's normal diff editor controls for split/unified mode.
5. Select a range, run **Open Exact-Revision Source**, choose a file/side, then **Return to Committed Source**. Expect the original native diff side, column and selection to return. Native document Find and Go to Line operate on that committed text. Language servers may not support virtual revision documents; ordinary workspace definition navigation does not imply it is committed PR source.
6. Mark a file through **Mark File Reviewed**, its sidebar check action or keyboard context menu. Reopen the same comparison and expect the mark to remain. Opening or merely visiting another file leaves it unmarked. Use **Remove Reviewed Mark** to clear it.
7. Save/stage a working-file edit and reopen the same committed document. Expect unchanged committed text. The ordinary file and terminal still use the earlier checkout. New GitHub source needs a newly verified overview/inspection; this slice does not claim continuous freshness or implement the later Sync workflow.
8. **Release Private Store** releases ownership without Git restoration. A later reopening must verify the original GitHub actor again. It is not Exit Review.

## Recovery and limits

- **Fetch failure or metadata movement:** preserve the preceding installed source. Explain configured Git transport versus API sign-in, refresh the overview and retry. Partial head/base inputs are never published as a new source.
- **Interrupted Git:** use **Recover Private Store** after its recorded host/child has stopped. Recovery observes actual owned refs, checks repository facts and records the outcome; it never repeats fetch. A live/uncertain process or changed repository stays blocked.
- **Interrupted source publication:** use **Reconcile Committed Source** with the source identity from the failure. It checks the saved plan, independent digest and pinned objects, then publishes the same comparison without another fetch. This action needs both fetched sides; it cannot certify a half-fetched installation.
- **Comparison loading:** the complete raw listing has a 15-second / 64 MiB bound. Exceeding it yields an explicit unavailable comparison with no partial list presented as complete. Individual text blobs have a 2 MiB bound. LFS pointers are identified without downloading LFS content; submodule contents are unavailable. Non-UTF-8 paths cannot be represented accurately and produce a comparison limitation.
- **History:** shallow repositories require ordinary Git history repair before retrying. Several merge bases do not cause an arbitrary base choice. Old source refs are intentionally retained for saved navigation; this slice adds no automatic ref cleanup.
- **Git capability:** the installed Git must support the source command's no-lazy-fetch/no-write-fetch-head flags. An older Git lacking those capabilities fails safely with a transport/source limitation; the general readiness target of Git 2.23+ alone does not establish this path's capabilities. This source path was exercised with Git 2.56.0 locally.
- **Native behavior:** source documents preserve text and exact identities, not a language server's project context. No fallback opens a current working line when committed source/range access fails.

## Validation evidence

`tests/committed-source.test.ts` drives the public manager against real disposable Git repositories, an isolated production SQLite worker/native guard and a loopback HTTP Git fixture. It covers staged/unstaged exclusion, mixed languages, 1,107 files, binary/LFS/large-file limits, metadata movement, explicit mark retention/clearing, restart/navigation, force-push/pruning, initially missing objects, missing blobs, renames, shallow/multiple-base comparisons and interrupted fetch/publication. The HTTP Git server stands in for remote transport; synthetic provider/account metadata is not evidence of a live private GitHub authentication flow.

`tests/host/readiness.ts` exercises the installed VSIX outside the source tree. It opens real native diff sides, read-only revision documents and generated overview links; restores selections to both diff sides; checks mark/unmark actions; changes split/unified mode, light/dark/high-contrast themes and zoom. Local macOS arm64 runs passed on VS Code 1.142.0 / Node 24.21.0 / Electron 43.7.7 / Chromium 150.0.7871.250. The six-cell CI matrix also runs these checks on minimum/current Windows x64, Linux x64 and macOS arm64; its actual PR results are the evidence for those cells.

Automated theme changes establish continued behavior, not visual or screen-reader parity. Manual assistive-technology, full narrow-layout/Figma comparison, power-loss durability and real public/private/fork credential scenarios remain bounded by the earlier host/storage/provider evidence. No public-distribution or complete-milestone claim follows from these source checks.

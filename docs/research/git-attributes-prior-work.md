# Git attributes and exact prior-work preservation

Research checked 21 October 2026. Sources are native Git manuals and versioned Git source. Local experiments used Git 2.56.0 on macOS in disposable repositories under `/private/tmp`; Windows, Linux and the minimum supported Git version were not tested in this research. The proposal below records the research-stage findings; current implementation and verified limits are in the linked walkthrough.

Implementation follow-through: the owner approved the canonical/raw approach in the discussion. [The implementation walkthrough](../development/prior-work.md#git-attributes-and-line-endings) records the resulting code and validation. The preview uses `checkout-index` with a scratch prefix instead of capturing converted file contents through `cat-file`; the temporary index preserves checkout attribute context and large file bytes do not pass through the ordinary 8 MiB inspection-output buffer. The proposal and research evidence below remain the basis, rather than a claim of cross-platform acceptance.

## Recommendation

Keep the existing verified stash and checkout workflow selected by [ADR 0002](../adr/0002-preserve-work-in-existing-checkout.md). Replace the presence-based refusal with per-path validation of ordinary built-in line-ending rules. Support normal LF and reversible CRLF by retaining two different facts: the exact bytes on disk and the Git representation that the stash must contain. Prove conversion back to disk produces the original bytes before authorizing stash or checkout.

Start with stable tracked `.gitattributes` files: no staged, unstaged, new or deleted attribute files. Continue refusing custom content filters, `working-tree-encoding`, `ident`, custom merge drivers, unsupported conversions and changes to external attribute inputs during the session. This is a bounded first version, not support for arbitrary Git transformations.

## Verified Git behavior

`.gitattributes` assigns per-path values. The highest precedence is `.git/info/attributes`, followed by nearer directory attribute files, then global/system attributes; later matching lines override earlier lines per attribute. Check-in normally prefers working-tree attribute files, falling back to the index; checkout prefers the index. `text`/`eol` normalize or select line endings; `working-tree-encoding`, `ident` and custom filters can change content in other ways. A `binary` macro can expand into several built-in attributes. Attribute presence alone does not establish whether any affected content changes. [Git attributes manual](https://git-scm.com/docs/gitattributes)

`git check-attr -z --stdin <attributes...>` accepts NUL-separated paths and emits NUL-separated path/name/value triples. `--cached` reads attribute files from the index; `--source=<tree>` selects a committed tree. `--all` omits unspecified attributes and does not report fallback configuration such as `core.autocrlf`. The states `set`, `unset`, `unspecified` and string values must stay distinct. [Git check-attr manual](https://git-scm.com/docs/git-check-attr)

`--source` arrived in Git 2.40. An older baseline needs an isolated temporary index, `read-tree <target>` and `check-attr --cached`; it must not silently acquire a new minimum Git requirement. [Git 2.40 release notes](https://raw.githubusercontent.com/git/git/v2.40.0/Documentation/RelNotes/2.40.0.txt)

`core.autocrlf=true` enables automatic normalization and CRLF checkout; `input` normalizes without output conversion. `core.eol` supplies a fallback checkout convention. `core.safecrlf=true` rejects some irreversible conversions, but `warn` only warns, and neither proves behavior under later configuration changes. Git explicitly explains that normalization can destroy the original placement of mixed LF/CRLF endings. `attr.tree` can redirect attribute lookup to a tree. [Git configuration manual](https://git-scm.com/docs/git-config)

Conversion also depends on the existing index: with `text=auto`, Git can retain CRLF when that path's indexed blob already contains CRLF. The current conversion attribute list includes legacy `crlf` as well as `text`, `eol`, `filter`, `ident` and `working-tree-encoding`. A hand-written LF/CRLF converter would have to reproduce these subtleties. [Git conversion implementation](https://github.com/git/git/blob/v2.56.0/convert.c)

A stash has separate working-tree and index trees; `apply --index` attempts to restore the staging distinction but is allowed to fail. Successful command exit alone does not promise byte identity. [Git stash manual](https://git-scm.com/docs/git-stash)

The native implementation creates the tracked working tree from the saved index, then updates paths using `update-index`. Untracked content also goes through `update-index` with a separate temporary index; it is not an archive of raw disk bytes. Stash apply runs a merge, reinstates the recorded index and restores untracked content. [Git stash implementation](https://github.com/git/git/blob/v2.56.0/builtin/stash.c)

Stash apply's merge can reach `ll_merge`. Custom `merge.<name>.driver` commands run through a shell; `merge.default` can select them even without a path-specific merge attribute. Named user drivers are searched before built-in string names. Returning to the exact original base normally makes the merge trivial, but does not justify treating every merge attribute/configuration as harmless. [Merge algorithm](https://github.com/git/git/blob/v2.56.0/merge-ort.c), [low-level driver selection](https://github.com/git/git/blob/v2.56.0/merge-ll.c)

Diff external commands and text conversion have explicit allow flags. Extension-issued diff probes should use `--no-ext-diff --no-textconv`; custom diff/merge values require checking the actual configuration and command path before being called safe. Export-only and language-display attributes do not by themselves imply content conversion. [Git diff implementation](https://github.com/git/git/blob/v2.56.0/diff.c)

Global/system attributes are independent of global/system Git configuration. `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null` do not remove default user/system attribute files: the attribute implementation reads them separately, controlled in part by `GIT_ATTR_NOSYSTEM`. [Attribute implementation](https://github.com/git/git/blob/v2.56.0/attr.c)

Newer Git can report effective attribute-file locations with `git var GIT_ATTR_SYSTEM` and `git var GIT_ATTR_GLOBAL`; the paths can name files that do not exist. This capability also needs version detection before use on an older baseline. [Git var manual](https://git-scm.com/docs/git-var)

## Local experiments

All cases used ordinary `stash push --include-untracked` followed by `stash apply --index` on the original commit. Staged entries were compared separately from raw file bytes.

| Case | Observed result |
| --- | --- |
| Stable `* text=auto eol=lf`, staged and unstaged LF content, untracked LF file | Disk and index restored exactly. |
| Same rule, tracked and untracked files containing CRLF | Apply succeeded and index matched, but both disk files became LF. |
| Stable `eol=crlf`, consistent CRLF work files | Ordinary CRLF tracked/untracked work restored exactly. |
| Attribute file changed from `eol=lf` to `eol=crlf`, once staged and once unstaged | Content/index restored, but the attribute file's original LF bytes became CRLF; exact restoration failed. |
| Existing CRLF blob in HEAD/index under `text=auto eol=lf` | `hash-object --path` predicted LF; copied-index `update-index` and the real stash both retained CRLF. Same result when the CRLF blob existed only in the staged index. |

The last case is critical: bare `hash-object --path` is not a reliable replacement for the index-aware path that stash uses. The [hash-object implementation](https://github.com/git/git/blob/v2.56.0/builtin/hash-object.c) does not load the actual index in the same way as `update-index`. The mismatch was observed, not just inferred from source.

## Proposed changes to existing functions

1. Extend `RepositoryOperation.git()` through a narrowly scoped scratch-operation helper. It needs bounded binary stdin/output and agent-created temporary index/object locations. Existing Git environment restrictions must remain; arbitrary caller-supplied Git environment overrides should not be exposed. Current inspection limits are three seconds and 8 MiB, while inventory permits 128 MiB, so materializing large files needs streaming or an explicit compatible bound.
2. Add one shared representation helper used by `workManifest()` and `checkoutState()`. First ask Git for effective transformation/merge attributes and relevant configuration; reject unsupported helpers before any content conversion. For current prior work, require stable attribute files and compare working-tree/index attribute contexts. For the target commit, use `check-attr --source` when available or `read-tree` plus `check-attr --cached` in a temporary index. Reject unsupported target attributes before switching.
3. In scratch storage, reconstruct the staged index with its exact blob IDs and zeroed/untrusted stat information; then run the same native `update-index` conversion path as stash for tracked files. Use a separate empty scratch index for untracked files. This avoids both the `hash-object` legacy-CRLF mismatch and accidentally trusting copied stat-cache fields. This exact scratch procedure still requires implementation fixtures; only copied-index `update-index` was experimentally checked here.
4. For each resulting canonical blob, ask Git for its checkout-form bytes using supported effective rules and compare to the recorded raw bytes. The required equation is `checkout(store(original bytes)) === original bytes`. Check all original files, including currently Git-clean files and attribute files themselves. Keep the existing index separately; never replace it with the canonical disk snapshot.
5. Extend `WorkManifest` with expected canonical stash entries, leaving raw entries as the final restoration authority. `verifyStash()` compares stash W/untracked trees with canonical entries and its index parent with original staged entries. `matchesManifest()` must still establish exact disk bytes and modes, staged entries and untracked membership.
6. Change `checkoutState()` to compare a working file with Git's checkout-form bytes of its indexed blob. Merely checking `store(disk) === index` loses hidden representation changes: an LF file under `eol=crlf` can look clean to Git but later return as CRLF. Keep the raw-byte fingerprint and check every file rather than relying on status/stat caches.
7. Extend `validateStash()`, `stashOutcome()` and `preserveCheckoutWork()` to revalidate saved effective attributes/configuration before restoring or classifying recovery. Separate immutable stash verification from checks against the currently checked-out PR's attributes. Preserve pins/receipts on uncertainty. Check that rules and repository facts did not change between inventory, preflight and mutation.

`cat-file --filters --path=<path> <blob>` returns checkout-form bytes under the current working-tree rules; it is not automatically a prediction for a different tree's attribute context. Stable original attributes make that usable after rule validation. Target checks must use their own context. [Git cat-file manual](https://git-scm.com/docs/git-cat-file)

Scratch writes can be isolated with `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and `GIT_INDEX_FILE`: new objects go to the scratch object directory, while existing objects can be read from the repository. This makes a probe non-mutating with respect to the user's checkout/index/references. It still writes temporary files and must use correct platform path-list quoting. [Git environment documentation](https://git-scm.com/docs/git)

## Alternatives and limits

A smaller change can allow only files whose stored bytes and checkout bytes already equal their raw bytes. It fixes this repository's ordinary LF case with less schema change, but excludes normal CRLF checkouts and therefore leaves a significant Windows limitation. The canonical/raw design above is the recommended scope if normal cross-platform line-ending support is expected.

An independent raw snapshot could preserve otherwise irreversible mixed endings or encoding/filter output. `hash-object --no-filters` can store exact bytes, but a hash alone is not durable protection; objects must be written, reachable/pinned, verified and restored through new crash-safe file-write stages. Supporting arbitrary filters also introduces external execution and nondeterminism. This is a larger recovery protocol, not needed when the supported native conversion has first been proved reversible. [Git hash-object manual](https://git-scm.com/docs/git-hash-object)

Explicitly test/refuse: LF/CRLF mixtures that fail the roundtrip, CRLF under LF checkout rules, LF under CRLF checkout rules, missing/modified/new attribute files, nested overrides, default global/system/info attribute changes, `attr.tree`, legacy CRLF in the index, custom merge/default drivers, binary detection, untracked transformations, target-only unsupported rules, SHA-1/SHA-256 and executable modes. Run cross-platform Enter/Exit and interrupted-recovery fixtures before declaring support.

The remaining concurrency gap is a noncooperating process changing attributes/configuration after validation but before native Git reads them. Rechecking narrows that gap but does not lock external attribute files. The implementation should explicitly retain the existing conservative interference/recovery behavior and avoid promising an atomic transaction across Git configuration, external files and the worktree.

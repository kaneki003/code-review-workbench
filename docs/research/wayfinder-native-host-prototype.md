# Native anchored reading and writing experiment

15 October 2026 · evidence for [Validate anchored reading and autosaved writing in native VS Code](https://github.com/kaneki003/code-review-workbench/issues/5).

**Decision pending owner reaction.** This report is a bounded native experiment, not approval of a UI deviation or an implementation-ready design. The prototype is in `src/prototypes/native-host-prototype/` on its throwaway branch.

## Environment and method

Measured installed desktop VS Code **1.141.2**, commit `16507d91be0dc1ce4f94c04d4d0430210b8685d9`, macOS arm64. Inside the extension host: Node **24.21.0**, Electron **43.7.7**. The shell's Node 24.22.0 is a different runtime. This run does not establish behavior on the research target 1.142.0, an eventual minimum supported version, Windows or Linux.

Launched a dependency-free JavaScript development extension, first using an isolated `/private/tmp` user-data/extensions directory. The native UI tool selected the existing VS Code process, so UI interactions used a separate named profile in that process. VS Code supplied regular extension global storage in that run; the prototype owns only its own storage subdirectory. No user repository was switched or modified by the extension.

Interactions used the native app accessibility tree and keyboard/pointer APIs. Native screenshot capture returned **Screenshot unavailable**. Consequently, accessibility-tree rendering and exact runtime/disk records are evidence; pixel layout, contrast and screenshot comparison are not verified. A visible native UI remains available for the owner to inspect.

## Findings so far

| Probe | Observed result |
| --- | --- |
| Ordinary native diff | `vscode.diff` opened immutable original `6dcb810` and inspected `7e93a1` URIs. The current editor and two current thread containers were present in the native accessibility tree. |
| Two controllers at the same range | Separate collaborator and Companion thread containers both reported lines 76–81. The collaborator offered Reply; the Companion was read-only. Native host styling/glyphs remain host controlled. |
| Native unfinished reply | Typed multiline Unicode text and an unfinished suggestion block. Collapse displayed: “Collapsing this comment thread will discard unsubmitted comments.” Discard was exercised on this fictional input only. No local draft had been created automatically. |
| Generic document events | `workspace.onDidChangeTextDocument` did emit `comment`-scheme changes during native typing. This corrects any stronger inference that no typing can be observed at all. No stable documented mapping from that internal model URI to the owning thread/controller was established or used to save it. |
| File-level record | Creating a thread and then setting `range = undefined` produced a record in native Comments. The host described it as line 1 in the accessibility tree despite the API property being undefined. Do not promise a distinct file-level native presentation. |
| Owned alternative input | Real textarea input saved `Panel draft — Ω`, blank lines and an unfinished suggested-change block: 61 JavaScript characters including whitespace/newlines. Disk text matched, with the original revision/path/range/thread retained separately. |
| Close | Save revision 2 retained those exact 61 characters and returned through `showTextDocument` to current source line 76. It did not restore focus to the precise native thread header. |
| Evidence and return | The log records source focus at `7e93a1/src/storage/export_store.ts:2`, then return to `7e93a1/src/workers/worker.ts:76`. Ordinary source tabs were used. |
| Host reload | The next activation restored revision 2, 61 characters and the same original anchor from disk. This establishes acknowledged-text survival across this reload, not power-loss durability or all timing races. |
| Original source | Navigation opened ordinary `worker.ts` at `6dcb810`, with the earlier-source record in Comments and lines 76–79 selected. It did not relabel that record as current. |
| Unavailable anchor | Native editor showed the retained original `removed.ts:400 · 01dead0` target and an explicit unavailable-source explanation. No current thread was fabricated. This is fixture recovery, not a real GitHub inaccessible-source response. |
| Failed save and retry | With failures enabled, appending `Unsaved failure probe` produced **Could not save · Retry**, retaining the visible edit. Disk stayed at revision 10, exactly 61 characters. Disabling failures and selecting Retry saved all 82 characters as revision 11. |
| Writer DOM recreation | A changed render identifier forced DOM replacement. The writer's new ready event restored revision 11 and 82 characters. |
| Actual view disposal/recreation | Moving the writer into the Primary Sidebar logged `writerDisposed`; the replacement view restored revision 11 and 82 characters. Moving it back into Panel preserved the same original anchor. |
| Narrow width | The actual sidebar webview measured **297 × 727 CSS pixels**, reported no horizontal page overflow, and exposed Feedback, Close, Retry and Return controls in the native accessibility tree. This establishes reflow metrics/control presence, not visual inspection at narrow window size. |
| Companion move/hide | Moved the companion from Secondary Sidebar to Panel and back through native menus. Context / Chat remained in its webview. Hiding the companion left the writer usable; its width changed from 786 to 1082 CSS pixels without extension-controlled resizing. |
| Themes | Measured `vscode-dark`, `vscode-light` and `vscode-high-contrast` classes in the actual writer. Each measured state reported no horizontal page overflow. CSS uses host variables. Contrast, clipping below the viewport, and pixel styling remain unverified. |
| Keyboard return | Escape in the owned writer logged a save, Close and return to `7e93a1/src/workers/worker.ts:76`. The ordinary editor selected the original range. A full keyboard-only journey, exact native header focus, Accessible View use and screen-reader spoken output remain unverified. |

## Supported-contract boundary

The stable comment API delivers `CommentReply.text` when a contributed action runs; it has no thread-owned input-change event or value property. Generic text-document events were observed in this host, but their internal `comment` URIs are not a documented ownership/identity contract. No internal URI parsing, proposed API, arbitrary inline HTML zone or custom code editor was used. The approved owned input under the source card remains unsupported by the researched public contract. [Stable comment API](https://code.visualstudio.com/api/references/vscode-api#CommentReply), [webview surfaces and lifecycle](https://code.visualstudio.com/api/extension-guides/webview), [host research at its exact commit](https://github.com/kaneki003/code-review-workbench/blob/0e321b3bcfa8e15284bde7f65a18db33ec80f195/docs/research/wayfinder-host-capabilities.md).

The candidate compromise keeps native inline reading and ordinary source/diff tabs, and moves **only feedback writing** to a compact, movable bottom-panel webview. Its header carries the original file, range, revision and thread. Context / Chat remains in the separate companion. This is a change to the approved composer placement and requires the owner's explicit decision.

## Errors corrected during setup

The first manifest used periods in view-container IDs. VS Code rejected those IDs and put the views into Explorer; the IDs were corrected to hyphens. An initially attempted additional comment action menu was identified by the host as proposed and removed. The corrected prototype declares no proposed APIs. Initial setup logs are not evidence that either invalid contribution worked. Later native trees show navigation, bottom panel and secondary-sidebar companion in their own containers.

The UI tool can return accessibility data before asynchronous palette/reload/webview focus changes settle. During a later automation attempt, four command-prefix characters and then a duplicated fixture string entered the test textarea. These are test-input changes, not lost preexisting work; the initial 61-character Close/reload evidence precedes them. Disk logs retain their revision counts. This is also why later results must be confirmed against disk and fresh UI state rather than inferred from an attempted shortcut.

## Evidence and decision boundary

- [Runnable prototype](../../src/prototypes/native-host-prototype/README.md).
- [Runtime audit, with storage paths normalized](../../src/prototypes/native-host-prototype/evidence/runtime-audit.jsonl).
- [Final acknowledged draft sample](../../src/prototypes/native-host-prototype/evidence/acknowledged-draft.json). Revisions 1–2 and 10 hold the 61-character sample; revision 11 adds the deliberate failure probe.

Source parsing and manifest JSON parsing pass. After correcting the initial manifest, subsequent renderer logs have no new contribution errors attributed to this prototype. No proposed APIs are declared. These checks and native observations do not replace a packaged extension test matrix.

**Owner reaction is pending.** The question presented is whether to accept native inline reading with a separate bottom-panel autosaving writer, preserving Context / Chat, with native thread styling and return to the source range rather than the exact thread header. An accepted treatment belongs in the decision resolution; this report does not silently amend the approved design.

Further validation must cover Windows/Linux and the chosen stable-version floor; pixel layout/contrast/zoom; full keyboard/screen-reader flow; split-diff side/gutter interactions; native raw-input navigation/reload behavior beyond the observed discard warning; crash/kill/power-loss and unacknowledged-write races; real storage failures; workspace restoration; GitHub/AI integration and packaging. Source tabs did not automatically restore during a fixture reload before the content provider activated; this experiment proves reopening and draft survival, not complete review-session restoration. Native source focus was observed, but exact header focus was not implemented. No production storage or framework is selected.

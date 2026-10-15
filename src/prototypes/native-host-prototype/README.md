# Native host PROTOTYPE — disposable evidence

Question: can stable public VS Code APIs deliver the approved source-anchored reading and autosaved writing? This extension tests that boundary and a separate bottom-panel writer. The owner accepted moving the writer to the bottom, requiring its styling/internal layout to follow Figma and everything else to stay as approved. These plain prototype controls are not the accepted visual design. This is not production extension code or an architecture selection.

Run from the repository root:

```sh
sh src/prototypes/native-host-prototype/run.sh
```

No build or dependency installation is needed. The default run uses `/private/tmp/crw-native-host-profile`, with its own extension directory. Run **CRW Prototype: Open native review fixture** from the Command Palette. Then run **CRW Prototype: Open anchored local draft**, or use the navigation tree/status bar. The source and diff are ordinary native editors backed by a read-only content provider. All source, users, revisions and review records are fictional.

For automation tools that cannot select a second VS Code process, this alternative creates a separate named settings profile in the existing VS Code instance:

```sh
CRW_PROTOTYPE_NAMED_PROFILE=1 sh src/prototypes/native-host-prototype/run.sh
```

That alternative is **not fully isolated storage**: VS Code supplied the regular `User/globalStorage` location for this extension during the measured run. Only this prototype's own `crw-prototype.crw-native-host-prototype` storage is used. Existing repositories and extensions are not accessed by the prototype. No network, credentials, Git operations, subprocesses, publication or AI connection are implemented.

Try the following:

1. Open the native review fixture. Both controllers have a thread at current lines 76–81. The collaborator controller has a native reply input; the Companion thread is read-only. Native Comments also lists the original-source and file-level records.
2. Type unfinished input in the collaborator's native Reply field, then collapse it. The host can warn that unsubmitted input will be discarded. **Capture input explicitly** is a local-only action testing `CommentReply.text`; it is not autosave or a GitHub action.
3. Open the anchored local draft. Type any multiline text. **Saved on this device · revision N** acknowledges a completed write/rename in this disposable experiment. **Close**, or Escape within the writer, retains text and returns to the source range. Reopen from the navigation tree/status bar.
4. Open evidence and return, recreate the writer DOM, hide/reopen the panel, and reload the window. Compare the restored text and original anchor. DOM recreation changes the document even if its contents otherwise match.
5. Toggle failing saves with **CRW Prototype: Toggle failing draft saves**. Edit text and observe **Could not save · Retry**. Toggle failures off, then Retry. Acknowledged state is the supported survival claim of this experiment; unacknowledged edits are not crash safe.
6. Move/hide the companion using the host view menu. It retains Context / Chat. Narrow the writer, switch themes and use keyboard controls. No fixed right-side placement or width is imposed by the extension.

**CRW Prototype: Open audit log** exposes measured versions, source navigation, saves, lifecycle and writer theme/viewport metrics. The draft and audit files are under the host-supplied `globalStorageUri`. The file records `anchor` separately from `text`; navigation does not retarget it.

The writer deliberately has no publishing controls. Its plain HTML and write/rename storage do not constitute a selected framework, transactional store, OS crash/power-loss guarantee, privacy encryption, packaged extension or production failure-recovery design. Failure/recreation races and full accessibility need later design and tests. Never merge this throwaway branch into main.

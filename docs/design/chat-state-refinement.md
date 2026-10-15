# Chat generation, stopped, and error states

Updated 15 October 2026 in the [existing Figma file](https://www.figma.com/design/iUydEGUJkOMhggD3wMTFKU?node-id=6-12).

Screens 11 (`6:12`), 12 (`6:13`), 13 (`6:14`), and 14 (`6:15`) now reuse the same editable `Companion/Conversation shell` component (`100:10998`), derived from the approved screen-12 conversation. Both original user questions, the earlier answer and inspection list, source link, revision, and anchored composer remain visible. The shared companion chrome, sidebar, and centre editor are preserved.

Streaming is a Figma simulation with two partial text snapshots and the existing complete state. Screen 11 shows “Start with a slow mocked upload” for 1.3 seconds. One added frame, `11b • Chat generating / continued` (`101:11081`), shows “Start with a slow mocked upload and observe whether buffering stays bounded.” for 1.8 seconds. It then opens the complete screen 12. These are the only timed text snapshots; there are no per-token frames.

During both streaming states, the same 30px composer control displays a stop square in the send position. Stop stores the exact displayed prefix in `prototype/chat-retained-response` (`VariableID:100:11008`) before opening screen 13. Its response text is bound to that variable, so stopping at either snapshot preserves the correct text. A small normal Stopped label and Regenerate action sit beside the affected response; the composer returns to Send. Regenerate starts a new prepared generation.

Screen 14 retains the same transcript and partial response, with compact “Response interrupted.” text and Retry beside the affected answer. The input and Send control remain usable. Retry opens the continued snapshot and proceeds to completion without adding another user message or clearing the response context. The error screen remains an existing standalone prototype recovery starting point; no artificial failure control was added to the product UI.

All five prepared states retain exactly two user messages and the same worker.ts:49–81 / 7e93a1 source context. Source links retain the cited-source destination `12:1857`. Stop and Send share the exact root-relative bounds x1387, y799, 30×30. The transcript fits its 556px scroll region in every snapshot; the anchored composer does not move.

Visual review passed for both generating snapshots, complete, stopped, error, and the full generating workspace. Saved-graph checks passed shared-component reuse, progressive prefixes, source targets, retained partial text, no duplicated user messages, font families, editable layers, and preservation of the existing four screens' sidebar/editor/chrome geometry. The retained-text variable was exercised with the early prefix and restored to the later prefix; both stopped and error bindings followed it correctly.

This is design and saved-prototype validation. Live Figma player playback, actual typing, keyboard behavior, and real model/network behavior were not exercised.

Current state: `figma-chat-state-refinement.json`. Apply ledger: `figma-chat-state-applied.json`. Added frame: `figma-chat-stream-frame.json`. Timing/actions: `figma-chat-state-wiring.json`. Checks: `figma-chat-state-checks.json` and `figma-chat-retention-check.json`. These supersede the older chat state decisions and body IDs in the companion/school ledgers.

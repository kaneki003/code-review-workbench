# Automated review of issue #20

Reviewed the feature branch against starting `main`, `c010c83c9ae40aba5959d12ffc6b234b02a5fcd0`, on 18 October 2026. The code-review skill ran independent Standards and Spec agents. Both checked the fixes through `9dd72ef` after their initial reports.

## Standards

The initial review found three documented-contract defects: a fetch prepared before an account change could still dispatch, delayed source reads could return after fencing, and raw diff could omit changed gitlinks under repository submodule-ignore settings. It also found that incoming source document URLs needed canonical side/path/revision validation. The optional duplication finding concerned repeated source-action lists.

The follow-up report confirmed all fixes. Source inspection carries its captured generation through fetch dispatch, queues and delayed replies are fenced while actual receipts/leases remain retained, Git comparison overrides submodule ignore settings, and the provider validates the canonical document URI. Manager authorization and worker routing now share the source-action list. No new actionable Standards or correctness finding remained. The reviewer inspected the regression tests and did not run them independently.

The CI matrix additionally exposed native editor-focus timing on macOS VS Code. Repeating Switch Side reproduced the failure locally. Focusing the editor group alone did not remove every failure: narrow native diffs can automatically collapse into unified mode, where the separate original widget cannot take focus. The installed-host regression now explicitly selects split mode for original-side assertions and exercises unified mode separately. Return restores native editor focus, observes either side of the actual diff before deciding to switch, and waits for the requested side before selecting its range. Its bounded wait preserves the saved target if VS Code cannot focus that side.

Windows passed the 141-test suite but the combined native-source case exceeded the runner's 25-second whole-case bound. Only that test case gets a 90-second Windows deadline; production operation/read/focus deadlines stay unchanged.

Both agents reviewed the final focus/layout/deadline follow-up. The Spec reviewer confirmed that observing either diff side before switching resolves the remaining focus-event race. Neither reviewer found another actionable regression.

## Spec

The initial review found that inspecting PR B between two inspections of unchanged PR A discarded A's explicit Reviewed marks, and that an intentionally absent addition/deletion diff side blocked subsequent navigation. It also identified incomplete keyboard/focus and narrow-layout evidence.

The follow-up report confirmed same-PR fingerprint retention and null-blob anchors for intentionally absent sides. Installed-host checks now observe keyboard file selection and list-focus restoration, plus navigation away from and back to both empty sides. No additional concrete defect was found in the fixes, and no scope creep was reported.

Narrow-layout visual evidence remains incomplete. Computer-use access to Code was not approved, so the attempted manual inspection could not establish that acceptance criterion. Automated light/dark/high-contrast changes do not establish visual or screen-reader parity. The draft PR must retain this limitation.

Final review outcome: zero unresolved actionable findings on Standards; zero unresolved concrete defects on Spec, with one documented acceptance-evidence gap for narrow layout. See the [source walkthrough and validation limits](committed-source.md).

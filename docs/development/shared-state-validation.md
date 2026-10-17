# Issue #18 checkpoint validation

Validated 17 October 2026 at `a46840a`, against starting `main` commit `69e9ab2c3ef25fc47cbfecf1878bbd235e35c768`. This covers the [ownership blocker checkpoint](shared-state-ownership.md), not completed shared storage.

## Tests

- Red: the two focused public-manager tests failed because ownership was still `pending`.
- Green: both focused files passed (12 tests), then `pnpm validate` passed formatting, typechecking and all 14 fast tests.
- `pnpm test:host` passed both installed-VSIX tests on macOS 25.6.0 arm64, VS Code 1.142.0, embedded Node 24.21.0, Electron 43.7.7, Chromium 150.0.7871.250, SQLite 3.53.4 and Git 2.56.0. Developer Node 24.22.0; pnpm 12.11.2.
- The installed command loaded the real React view and worker outside the source tree, reported ownership `blocked` and `reviewAvailable: false`, and preserved the disposable repository's files/index/refs. Reinvoking during view loading also passed.

No production store, competing-owner exclusion or recovery-file durability was tested. Minimum-host and Windows/Linux results for this revision are not established by this local run. The existing PR workflow schedules all six platform/version cells; inspect their completed results separately. Native accessibility/visual checks and Restricted Mode limitations remain as described in [readiness validation](readiness-validation.md).

## Standards

Separate automated reviewer: no documented-standard violations or actionable baseline smells. The workflow additions preserve the requested review stop; the readiness change stays at the public action; the tests use real Git/SQLite probes. The proposal preserves SQLite authority and explicitly leaves ownership acceptance open.

The reviewer checked the pinned Node/libuv sources and process documentation cited in the proposal. They support the stated API gaps, but do not prove native code mandatory.

## Spec

Separate automated reviewer: no actionable regressions, scope creep or incorrectly implemented checkpoint behavior.

#18 requires: “Open one shared durable private store, show its owning window, and stop a second or uncertain writer before any review mutation.” That implementation and its acceptance fixtures remain missing. This PR cannot complete #18.

The ticket permits a precise blocker for a required packaging/contract change. The proposal identifies native assets, build/copy rules and installed-host checks, acknowledges SQLite exclusion as an alternative, and distinguishes observed API gaps from an unproven bridge. The reviewer judged it an adequate decision checkpoint. Approval establishes neither safety nor native necessity.

Standards: 0 findings. Spec: 0 actionable regressions; all #18 storage/ownership acceptance remains open.

# Readiness validation

Evidence for issue #17, 16 October 2026. These are readiness-package checks; they do not establish the later review milestone, disk-backed SQLite durability, cross-window ownership or safe stash/checkout/restoration.

| OS / architecture | VS Code | Result |
| --- | --- | --- |
| Darwin 25.6.0 / arm64 | 1.142.0, current stable | Passed locally: installed VSIX outside source tree, real React handshake, worker transaction/rollback and unchanged repository manifest |
| Darwin 25.6.0 / arm64 | 1.141.2, minimum | Passed locally with the same installed-package and unchanged-repository checks |
| Windows / x64 | 1.141.2 and current stable | CI configured; no local evidence |
| Linux / x64 | 1.141.2 and current stable | CI configured; no local evidence |

Both passing local runs measured embedded Node 24.21.0, Electron 43.7.7, Chromium 150.0.7871.250, SQLite 3.53.4 and Git 2.56.0. Developer tools ran on Node 24.22.0 and pnpm 12.11.2. The worker uses the embedded runtime, not developer Node. The report also explicitly keeps review ownership pending and review availability false.

Automated review exposed a native attachment lifecycle failure: reinvoking while the first screen was loading produced a false reinstall error after 12 seconds. The installed-host regression reproduced that failure before the fix and passed afterward. Probes/cache are now scoped to each attachment and disposal settles cancellation. The runner also preserves Windows path arguments without a command shell and starts a fresh evidence file before each run; actual host versions, report and test failures are saved even when assertions fail.

The six CI cells run independent frozen installation, type checks, behavior/React tests and packaged-host checks. Each uploads the actual host evidence and VSIX, including on failure when available. Runner labels follow the [official GitHub runner matrix](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `windows-2025` x64, `ubuntu-24.04` x64 and `macos-15` arm64. A configured or queued cell is not support evidence; inspect its completed result and actual architecture before extending any support claim.

The [first matrix run](https://github.com/kaneki003/code-review-workbench/actions/runs/38903352648) passed both macOS and Linux cells. Both Windows cells failed before installation because the harness assumed an unversioned `resources/app/out/cli.js`; the actual Windows archive places it under a versioned directory. The harness now reads the exact CLI path from the packaged vendor launcher, validates that it stays within that installation and invokes it without a command shell. These failures are harness evidence, not passing Windows package evidence.

Fast tests cover unsupported host/trust/CPU inputs, missing repositories, unchanged dirty files/index/refs, missing-worker recovery, real in-memory worker execution, retry focus/name/text state and stale/malformed webview responses with untrusted text rendering. Real Git fixtures use the installed Git; Git 2.23 is the selected compatibility floor, not a locally validated old-Git version. Read-only discovery does not prove later mutating Git capabilities.

The host runner disables Workspace Trust through Microsoft's test-electron runner. Restricted Mode is therefore covered here by the manifest's native unsupported declaration and manager boundary tests, not claimed as an automated native Restricted Mode run. Remote/virtual/browser host checks are controlled environment fixtures, not actual remote sessions. Full screen-reader behavior and manual light/dark/high-contrast, zoom and narrow-layout inspection remain separate checks. React/jsdom tests do not establish those native behaviors. See the [official extension testing guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension) for the distinction between fast tests and desktop integration.

# Readiness implementation walkthrough

This is the first slice of [Install the workbench and check readiness](https://github.com/kaneki003/code-review-workbench/issues/17), based on accepted planning commit `a152c1f`. It checks the installation, not whether a review can start. No store location is discovered or registered, no ownership is claimed and no authoritative database is opened. The SQLite probe uses `:memory:` in the packaged worker. The ownership gate belongs to #18.

## Read the diff in this order

1. `package.json`, `pnpm-workspace.yaml` and `scripts/build.mjs`: exact dependencies, permitted build hooks and separate host/browser/worker/CSS outputs.
2. `src/application/review-manager.ts`: the public readiness action, environment gates and observable report. No VS Code or React imports.
3. `src/connections/git-readiness.ts` and `sqlite-readiness.ts`: bounded, read-only external probes; `readiness-worker.ts` exercises the embedded driver.
4. `src/shared/readiness.ts`: serializable reports and the finite versioned message protocol with runtime validation.
5. `src/extension.ts` and `src/vscode/readiness-panel.ts`: native command wiring, packaged-resource URLs and content policy.
6. `src/webviews/readiness-view.tsx`, `main.tsx` and `styles.css`: accessible controls, temporary display state and VS Code theme aliases.
7. `tests/`, `scripts/test-host.mjs` and `.github/workflows/check.yml`: behavior evidence and actual installed-package checks.

## Follow one action

Running **Code Review Workbench: Check Readiness** creates a native webview panel and calls the manager. The manager reads the current host facts. Unsupported trust, remote/virtual/browser/multi-root entry, runtime or CPU targets produce a blocked report before either probe executes.

For an eligible host, Git performs version and local working-repository discovery with optional locks disabled. Ambient `GIT_*` overrides are removed so they cannot redirect the read. The separate worker opens an in-memory SQLite database, inserts a parameterized value inside a transaction, rolls back and verifies the rollback. Errors and timeouts become blocked capabilities with recovery text.

The packaged React entry sends a bounded `ready` request with its view instance and request identities. The host validates those identities, sends the report and captures the renderer's user agent as display evidence. The command waits for that handshake; a missing script or blocked webview cannot pass the installed smoke check silently. Clicking **Check again** sends a new `recheck` request; responses for another instance or request are ignored.

The manager always returns `reviewAvailable: false`. A passing Git or SQLite check does not authorize checkout, private writes or later review operations. The report states which capabilities still require ownership, disk-durability and preservation fixtures.

## Framework concepts

The extension host is the local Node environment supplied by VS Code. A webview is a separate browser context; it can request this finite readiness action but cannot execute Git or select a worker path. A worker thread runs the built-in SQLite driver using the host's embedded Node. No worker framework, ORM, Git wrapper or dependency-injection framework is introduced.

esbuild transpiles and bundles JavaScript. `pnpm check` separately invokes TypeScript because a successful bundle does not establish type correctness. Tailwind runs at build time without Preflight; semantic aliases refer to VS Code theme variables. The VSIX allowlist includes only the manifest, README and four compiled assets. VS Code and Node built-ins stay external to the host/worker bundles.

## Develop, run and test

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec vitest run tests/readiness.test.ts
pnpm exec vitest run tests/readiness-view.test.tsx
pnpm test
pnpm package
pnpm test:host
```

`pnpm dev` watches JavaScript and CSS. Open the repository root in VS Code and use the **Workbench readiness** F5 configuration for a development host; it builds first. The packaged-host check is separate: it builds the VSIX, installs it into a disposable profile outside the source tree, loads a tiny test harness and drives the installed extension's command. It records versions and the report in `.host-test/evidence.json`; its console prints the disposable fixture directory for inspection. It never installs into your ordinary profile.

By default the host check downloads current stable. To select the minimum version:

```sh
CRW_VSCODE_VERSION=1.141.2 pnpm test:host
```

In PowerShell use `$env:CRW_VSCODE_VERSION = '1.141.2'` before `pnpm test:host`. `CRW_VSCODE_EXECUTABLE` may select an existing VS Code executable instead of downloading; evidence records the actual version. Linux needs a desktop display, or `xvfb-run -a pnpm test:host` in CI.

Only esbuild's required install hook is allowed. The resolved optional `@parcel/watcher` source-build hook is disabled because platform prebuilds are available; the `@vscode/vsce-sign` hook is disabled because this pipeline creates an unsigned local VSIX and does not sign/publish. Other dependency hooks remain restricted.

## A small change to try yourself

In `src/webviews/readiness-view.tsx`, change the button's idle label from **Check again** to **Run checks again**. Update the accessible-name expectations in `tests/readiness-view.test.tsx` and `tests/readiness-webview.test.tsx`. Run those two files and `pnpm check`, then use F5 to see the label. This checks your understanding of the difference between presentation text, protocol actions and the host-owned readiness rule. The `recheck` protocol action stays the same.

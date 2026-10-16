# Reviewing and developing the first extension

This PR gives us something we can install in VS Code and run: **Code Review Workbench: Check Readiness**. It shows the installed VS Code and Node versions, whether this is a supported workspace, whether Git can read the repository, and whether the packaged SQLite worker works.

It does not open a PR for review yet. This ticket establishes the installation and prerequisite checks that later review features will use. The SQLite test database lives in memory and disappears when its worker exits.

## Start by running it

Use Node 24.15 or newer within Node 24, and pnpm 12.11.2. From this feature worktree:

```sh
cd /private/tmp/crw-issue-17
pnpm install --frozen-lockfile
pnpm validate
pnpm package
```

In VS Code, run **Extensions: Install from VSIX…** and choose `dist/code-review-workbench.vsix`. Open a trusted local Git folder, then run **Code Review Workbench: Check Readiness** from the command palette.

For development, open this worktree in VS Code and press F5 using **Workbench readiness**. The launch configuration builds the extension and opens a separate development window. Run the readiness command in that window.

## The commands we use from now on

| Command                                        | When to use it                                  | What it does                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`               | After cloning or pulling dependency changes     | Installs exactly what the committed lockfile records.                                                                      |
| `pnpm format`                                  | After editing                                   | Uses the pinned Prettier version to format source, tests, scripts, configuration and these development docs.               |
| `pnpm format:check`                            | To check formatting without changing files      | Reports files that need formatting; also runs in CI.                                                                       |
| `pnpm validate`                                | Before committing                               | Runs formatting checks, TypeScript checks and all fast tests. This is the usual local check.                               |
| `pnpm check`                                   | While fixing a type error                       | Runs TypeScript without creating JavaScript output.                                                                        |
| `pnpm test`                                    | While changing behavior                         | Runs all 14 fast tests without launching VS Code.                                                                          |
| `pnpm exec vitest run tests/readiness.test.ts` | While working on the manager or its probes      | Runs one test file. Replace the path to run another file.                                                                  |
| `pnpm dev`                                     | While using the development window              | Watches JavaScript and CSS builds. It does not run typechecking or tests.                                                  |
| `pnpm build`                                   | To rebuild the files the extension loads        | Produces the host bundle, browser bundle, SQLite worker and CSS under `dist/`.                                             |
| `pnpm package`                                 | Before installing or sharing the extension      | Builds, then creates `dist/code-review-workbench.vsix`. A VSIX is VS Code's extension installer.                           |
| `pnpm test:host`                               | Before handing a runtime change back for review | Builds the installer, installs it in a disposable profile, launches real VS Code and runs the two installed-package tests. |

VS Code recommends the Prettier extension and formats on save when it is installed. The workspace settings use this repo's Prettier configuration; they do not change global editor settings. The command-line checks work without the editor extension.

Prettier controls layout. Readable control flow still needs review: use descriptive names, braces around branches, separate statements and named steps where a long callback hides its purpose. Explain why a timer, identity check or process boundary exists. Keep helpers next to the code that uses them.

## Follow the command through the code

Three environments participate:

- **Extension host:** the Node process supplied by VS Code. It can use VS Code APIs, run Git and start the worker.
- **Webview:** the separate browser context displaying our React screen. It asks the host to check readiness using messages.
- **SQLite worker:** a Node worker thread using the host's built-in SQLite driver. It keeps synchronous database operations off the extension host's main thread.

### 1. VS Code discovers and registers the command

`package.json` declares the command ID `codeReviewWorkbench.checkReadiness` and points `main` at `dist/extension.cjs`. That bundle comes from `src/extension.ts`.

VS Code calls `activate`. It creates the manager and supplies the three outside operations the manager needs:

```ts
const manager = new ReviewManager({
  environment: readHostEnvironment,
  git: probeGit,
  sqlite: () => probeSqlite(workerPath),
});
```

These are the **connections**. They are ordinary functions passed into the constructor. `readHostEnvironment` reads VS Code's current workspace facts; `probeGit` runs Git; `probeSqlite` starts the packaged worker. There is no container or service-discovery mechanism to learn.

`activate` then creates the panel controller, passing `() => manager.checkReadiness()`, and registers the command to call `panel.show()`. This is where the native command, manager and screen are linked.

### 2. The panel starts a check and loads the screen

`readiness-panel.ts` creates a webview panel, gives it the packaged stylesheet and browser script, and starts `checkReadiness()`.

Each opened panel owns its `pendingCheck`, `latestReport` and view identity. Opening the command again closes the old panel and creates new state. A result from the old panel cannot become the new panel's result.

The HTML uses VS Code resource URLs. Its content-security policy allows the packaged script with a generated nonce and the packaged stylesheet; it denies other content and network connections.

### 3. The manager decides which local probes may run

`ReviewManager.checkReadiness()` first checks workspace location, Workspace Trust, embedded runtime and platform. The small functions below the public method describe those rules individually.

If any of those checks fails, Git and the worker are skipped. Otherwise, both probes run and each contributes its own result. A failed probe becomes a blocked row; it does not prevent the other result from being shown.

The returned `ReadinessReport` contains `checkedAt`, a `checks` array and `reviewAvailable: false`. Each check has an ID, visible label, status and explanation. A passed Git or SQLite row is evidence about that capability; this implementation still cannot start a review.

### 4. Git and SQLite supply actual observations

`probeGit` runs `git --version`, then `git --no-optional-locks -c core.fsmonitor=false rev-parse --is-inside-work-tree --is-bare-repository`. It requires Git 2.23 or newer and an accessible non-bare working repository. It removes inherited `GIT_*` overrides so they cannot redirect the check to a different repository. Each command has a five-second timeout and bounded output.

`probeSqlite` starts `dist/readiness-worker.cjs`. The worker opens `:memory:`, creates a table, inserts a parameterized value inside a transaction, reads it, rolls back and confirms the table is empty. It sends its SQLite and Node versions back to the host. The adapter validates that message and stops the worker. Errors, a missing bundle or a five-second timeout produce a blocked row.

No shared review database or ownership record is created by these checks.

### 5. The browser receives and displays the report

`src/webviews/main.tsx` mounts `ReadinessView`. The component's effect calls its `check` prop. For the first call, `main.tsx` sends a `ready` message to the host.

The host command and this first browser message may overlap. `pendingCheck` lets them share the same work. The `ready` message also proves that the packaged browser script loaded; the command will fail if the screen never becomes ready.

The host validates messages through `src/shared/readiness.ts`, adds the browser's renderer version to the report and replies with `readinessResult`. The browser validates the response before passing it to React.

Two IDs prevent results from reaching the wrong place:

| Field        | Meaning                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| `instanceId` | Identifies one opened screen. Reopening creates a different ID.                       |
| `requestId`  | Identifies one check requested by that screen. Clicking again creates a different ID. |

A response must match both. Clicking **Check again** sends `recheck`, which starts a fresh check. React displays Checking, the report or a retryable error. It owns this display state; it does not run Git or open the database.

Closing during initial loading settles that command as cancelled (`undefined`) and clears its load timer. It must not later show a false message asking the user to reinstall the package.

## Reading order: every changed file

There are 38 changed files after adding the formatter and editor settings. The groups below account for all of them. Start with the behavior and wiring, then the tests, then the machinery that builds and checks it. Read the generated lockfile as dependency evidence rather than line-by-line application logic.

### 1. Entry point and what the user can run — 2 files

| File                               | Why it is here                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [README.md](../../README.md)       | Installation, usual development commands and links into the project.                                              |
| [package.json](../../package.json) | Extension command, compiled entry point, supported workspace declarations, scripts and exact dependency versions. |

### 2. Host behavior and outside operations — 5 files

| File                                                                             | Why it is here                                                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [src/extension.ts](../../src/extension.ts)                                       | Connects VS Code, the manager, the two probes and the panel; registers the command.                                  |
| [src/application/review-manager.ts](../../src/application/review-manager.ts)     | Decides whether probes may run and assembles their results. Its public action is the main behavior-test entry point. |
| [src/connections/git-readiness.ts](../../src/connections/git-readiness.ts)       | Executes the bounded, read-only Git commands.                                                                        |
| [src/connections/sqlite-readiness.ts](../../src/connections/sqlite-readiness.ts) | Starts the packaged worker, validates its result and handles failure/timeout.                                        |
| [src/connections/readiness-worker.ts](../../src/connections/readiness-worker.ts) | Runs the real in-memory SQLite transaction and rollback.                                                             |

### 3. Screen and messages — 5 files

| File                                                                     | Why it is here                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [src/shared/readiness.ts](../../src/shared/readiness.ts)                 | Defines reports/messages and checks received data at runtime. TypeScript types alone cannot validate a message. |
| [src/vscode/readiness-panel.ts](../../src/vscode/readiness-panel.ts)     | Opens/closes the native panel, loads packaged resources and handles browser requests.                           |
| [src/webviews/main.tsx](../../src/webviews/main.tsx)                     | Browser entry point: matches requests/responses and mounts React.                                               |
| [src/webviews/readiness-view.tsx](../../src/webviews/readiness-view.tsx) | Renders the button, progress, errors and capability rows.                                                       |
| [src/webviews/styles.css](../../src/webviews/styles.css)                 | Tailwind imports, VS Code theme aliases and visible keyboard-focus styles.                                      |

### 4. Tests and their fast-test configuration — 6 files

| File                                                                       | Why it is here                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [tests/readiness.test.ts](../../tests/readiness.test.ts)                   | Eleven manager scenarios, including real disposable Git folders.                            |
| [tests/readiness-worker.test.ts](../../tests/readiness-worker.test.ts)     | Runs the real compiled worker through the manager and checks that no disk database appears. |
| [tests/readiness-view.test.tsx](../../tests/readiness-view.test.tsx)       | Exercises the React error/retry control and its accessible name/focus.                      |
| [tests/readiness-webview.test.tsx](../../tests/readiness-webview.test.tsx) | Exercises the actual browser entry against controlled host messages.                        |
| [tests/host/readiness.ts](../../tests/host/readiness.ts)                   | The two tests that run inside real VS Code against the installed extension.                 |
| [vitest.config.ts](../../vitest.config.ts)                                 | Selects fast tests. React files select jsdom, a simulated DOM; host tests run separately.   |

### 5. Build, installed tests, editor and CI — 8 files

| File                                                             | Why it is here                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [scripts/build.mjs](../../scripts/build.mjs)                     | Bundles host/browser/worker JavaScript with esbuild and compiles CSS with Tailwind. Also supports watch mode.   |
| [scripts/pnpm.mjs](../../scripts/pnpm.mjs)                       | Starts the selected pnpm launcher without a Windows command shell, preserving path arguments.                   |
| [scripts/test-host.mjs](../../scripts/test-host.mjs)             | Builds/installs the VSIX, creates disposable fixtures and launches the real VS Code test runner.                |
| [.vscode/tasks.json](../../.vscode/tasks.json)                   | The build task used before F5 debugging.                                                                        |
| [.vscode/launch.json](../../.vscode/launch.json)                 | Launches a development VS Code window with this extension.                                                      |
| [.vscode/extensions.json](../../.vscode/extensions.json)         | Recommends the Prettier editor extension. It does not install it automatically.                                 |
| [.vscode/settings.json](../../.vscode/settings.json)             | Uses the repository's formatter and formats supported source/config files on save.                              |
| [.github/workflows/check.yml](../../.github/workflows/check.yml) | Runs formatting, typechecking, fast tests and installed-package tests on the six platform/version combinations. |

### 6. Formatting, compiler and packaging rules — 8 files

| File                                             | Why it is here                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| [.prettierrc.json](../../.prettierrc.json)       | Agreed formatting: single quotes, trailing commas, 100-column target and LF line endings.                                     |
| [.prettierignore](../../.prettierignore)         | Excludes generated output, the pnpm-owned lockfile and pre-existing planning/skill records; development docs remain included. |
| [tsconfig.json](../../tsconfig.json)             | Strict TypeScript checking for source and tests. esbuild does not perform this check.                                         |
| [.npmrc](../../.npmrc)                           | Refuses incompatible development Node engines during installation.                                                            |
| [pnpm-workspace.yaml](../../pnpm-workspace.yaml) | Allows esbuild's required install hook and explicitly disables two optional transitive hooks.                                 |
| [pnpm-lock.yaml](../../pnpm-lock.yaml)           | Generated record of exact resolved dependencies. This accounts for roughly 4,450 lines of the initial PR; pnpm maintains it.  |
| [.vscodeignore](../../.vscodeignore)             | Installer allowlist: manifest, README and the four compiled assets. Source and development tools stay out of the VSIX.        |
| [.gitignore](../../.gitignore)                   | Keeps dependencies, compiled output, VSIX files and disposable test output out of Git.                                        |

### 7. Walkthrough and recorded evidence — 4 files

| File                                                                  | Why it is here                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [docs/development/readiness.md](readiness.md)                         | This guide: commands, wiring, file map and test explanations.                                                                     |
| [docs/development/readiness-validation.md](readiness-validation.md)   | Actual platform results, failures and limits of what was checked.                                                                 |
| [docs/development/readiness-platforms.json](readiness-platforms.json) | Machine-readable version/test records copied from a completed CI run. It is evidence, not runtime configuration.                  |
| [docs/development/readiness-review.md](readiness-review.md)           | Earlier automated-review findings and the changes that addressed them. Read after the implementation if you want the bug history. |

## What each test checks

`pnpm test` runs 14 fast tests across four files:

| Test file                                   | Scenarios and observations                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/readiness.test.ts` — 11 tests        | Remote SSH; untrusted folder; browser VS Code; no folder; virtual folder; multiple folders; old VS Code; wrong Node major; unsupported CPU; a folder without a Git repository; a dirty Git repository with a missing worker. Unsupported setup skips both probes. Missing repositories stay missing. The dirty-repository case checks the original file contents, index bytes and refs afterward, and checks that missing-worker failure leaves review ownership pending. |
| `tests/readiness-worker.test.ts` — 1 test   | Compiles and starts the production worker, calls the manager, observes successful SQLite transaction/rollback and checks that the directory contains only the worker bundle afterward.                                                                                                                                                                                                                                                                                    |
| `tests/readiness-view.test.tsx` — 1 test    | Provides a failing host callback, observes the error, focuses the named retry button and retries. This checks React behavior in jsdom, not native screen-reader behavior.                                                                                                                                                                                                                                                                                                 |
| `tests/readiness-webview.test.tsx` — 1 test | Imports the real browser entry. Sends malformed data, another view's response and an older request's response; they are ignored. Sends script-looking text; it appears as text. Clicks **Check again** and confirms it requests `recheck` with a new request identity.                                                                                                                                                                                                    |

The fast tests supply controlled VS Code environment facts. The Git scenarios use real temporary folders and installed Git; the worker scenario runs the real driver in a real worker. Simulated host facts are useful for failure cases but do not prove the production VS Code adapter reports the right facts on an OS.

`pnpm test:host` provides that separate proof by running two tests inside real VS Code:

1. **Installed package works outside the source tree.** The extension must come from the temporary extensions directory, load its bundled browser code, run the packaged SQLite worker and report actual capabilities. Hashes of every fixture repository file, including `.git`, must match before and after the command.
2. **Reopening during loading cancels the first command cleanly.** The test opens the command, waits for its tab, immediately opens it again and checks that the first command resolves as cancelled while the replacement screen loads. This caught a real false-reinstall error during implementation.

CI runs frozen installation, formatting, types, fast tests and these two installed tests on Windows x64, Linux x64 and macOS arm64, each with VS Code 1.141.2 and current stable. Results and actual runtime versions are recorded separately in the validation document.

## Running and diagnosing the installed tests

The default is current stable. To choose the minimum:

```sh
CRW_VSCODE_VERSION=1.141.2 pnpm test:host
```

In PowerShell, first set `$env:CRW_VSCODE_VERSION = '1.141.2'`, then run `pnpm test:host`. `CRW_VSCODE_EXECUTABLE` can select an existing VS Code executable instead of downloading one. Linux CI uses `xvfb-run -a pnpm test:host` to provide a display.

The script prints the disposable fixture directory and records the current run in `.host-test/evidence.json`, including failures. It resets evidence at the start so an older success cannot masquerade as the latest run. Your usual VS Code profile is not used.

The runner needs a tiny development harness to execute Mocha tests, but the workbench itself is installed from the VSIX. This distinction is what lets the test catch missing packaged assets or accidental dependencies on the source tree.

## A small change to make yourself

When you are ready, change the idle button label in `src/webviews/readiness-view.tsx` from **Check again** to **Run checks again**. Update the accessible-name expectations in the two React test files, then run `pnpm format` and `pnpm validate`. Use F5 to see it.

The message action remains `recheck`: it names the host operation, while the button label is presentation text. Follow that action from `main.tsx` into the panel's message handler to check your understanding of the connection.

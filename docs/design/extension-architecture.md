# Extension architecture and framework

Status: accepted architectural contract, 15 October 2026. The owner confirmed shared understanding across the three discussion rounds, selected Tailwind CSS for styling and pnpm for package management, and accepted the build/test/version/validation plan. This is a planning decision, not production implementation or the complete technical design.

Decision: [Choose extension architecture and framework](https://github.com/kaneki003/code-review-workbench/issues/6), within [Plan the Code Review Workbench technical design](https://github.com/kaneki003/code-review-workbench/issues/1).

## In plain language

Build one installable VS Code extension. Its custom screens use TypeScript, React and Tailwind CSS. A central review manager coordinates actions and review data; small review-rule functions calculate results; separate connections handle storage, Git, GitHub and AI. Closing a screen must not erase the review or change the destination of unfinished feedback.

Develop for one junior developer maintaining the project. Prefer explicit functions, a small dependency set and ordinary folders. Explain why a boundary exists before introducing an abstraction. The first implementation milestone remains opening a real PR locally, navigating its diff, saving an anchored local draft, resuming and exiting safely; this decision does not implement that milestone.

## Confirmed decisions

- One extension, with clear internal responsibilities. An independently installed or always-running background service is outside the initial architecture. Git tools and a future supported AI runtime may require child processes managed through their own connections.
- TypeScript throughout; React for owned webviews; Tailwind CSS for styling. Preserve the approved Figma appearance and internal layout, adapting colours and accessibility to the user's VS Code theme.
- Local desktop workspaces on Windows, macOS and Linux. Remote SSH, WSL, Dev Containers, Codespaces, tunnels and browser-hosted VS Code are deferred. Platform support must be validated before it is advertised.
- The review manager coordinates authoritative local review state independently of webview lifecycle. GitHub remains authoritative for its pending reviews, published discussion, permissions and merge outcomes.
- Require VS Code Workspace Trust for MVP rather than provide a second restricted-functionality mode.
- Add a PR discussion section to the existing ordinary Markdown PR overview for PR-level comments, submitted review summaries and threads whose source location is unavailable. Preserve authors, replies and original source information. Reply opens the existing bottom composer. Source-anchored discussion remains beside code; the separate Review activity page remains removed.
- Use pnpm, esbuild, Tailwind CLI, a separate TypeScript check, Vitest/React Testing Library and Microsoft's desktop integration test tools. Package with vsce. The selected minimum VS Code is 1.141.2; developer/CI Node is the 24 LTS line at 24.15 or later. Validate minimum and current stable on the initial three-platform matrix before advertising support.

The owner accepted these in the [foundation exchange](https://github.com/kaneki003/code-review-workbench/issues/6#issuecomment-6190870661) and [ownership/discovery exchange](https://github.com/kaneki003/code-review-workbench/issues/6#issuecomment-6191007597).

## Host and process boundaries

The extension's main entry runs in the local desktop Node.js extension host. Declare extensionKind as ["ui"] and omit a browser entry. Check the actual environment before opening a review or touching repository paths: a remote session, virtual workspace or non-local repository URI does not become supported because the UI happens to run locally. Explain the unsupported environment and offer opening a local folder; do not map remote URIs to local filesystem paths or save private records on a remote host.

Each webview has its own browser context and communicates with the host through messages. It receives only the data needed for its screen. It does not execute Git, contact GitHub/model endpoints, own credentials or decide publication eligibility.

Keep host work asynchronous. Filesystem/network calls and child-process output must not block the extension host. Bound captured output and expensive parsing; if profiling shows sustained CPU work, isolate that work behind the existing connection boundary in a worker or child process. No extra service or worker framework is required initially.

One review manager exists in the owning window; it is not a magical singleton shared across VS Code processes. The one-active-review product rule also applies across windows. The storage decision must define ownership/locking and recovery; another window must not start conflicting operations while ownership is held or uncertain. Do not claim that an in-memory flag solves this.

## Native surfaces and owned screens

| Surface | Responsibility and boundary |
| --- | --- |
| Ordinary source and diff tabs | Keep native editing/navigation, split/unified diff support and normal tabs. Historical sources use revision-specific document identities; ordinary working files remain ordinary files. The Git decision determines how source bytes are obtained. |
| Native inline threads | Read collaborator discussion, Companion suggestions and tagged local drafts at their actual source targets. Keep attribution and private/pending/published distinctions. Editing/reply actions open the owned composer; native reply input is not the autosave mechanism. |
| Review navigation | An owned, themed webview in a native view container preserves the selected repository/PR controls, checkpoint navigation, all-files mode, draft discovery and workbench actions. Reuse native commands/Quick Picks where they fit without replacing the approved layout. |
| PR overview | A generated, read-only Markdown document in an ordinary editor tab. Preserve approved overview content and add PR discussion as explicitly accepted above. Local drafts are separate records and do not become GitHub discussion. |
| Context / Chat companion | An owned React webview, with the existing tabs and state retention. Default it beside the code; it must remain usable when moved, resized or hidden. |
| Feedback composer | An owned React webview contributed to the bottom Panel. Preserve Figma styling/control hierarchy/internal layout. Show the original PR/file/range/revision/thread target; PR-wide feedback has an explicit PR target and no invented line anchor. |
| Finish review | Preserve the approved composition/overlay flow within the owned review UI: exact included pending comments, excluded unfinished drafts, summary, explicit decision and inspected source. Submission, merge and Exit Review remain separate actions. |
| Terminal | Preserve ordinary user terminals. Workbench checks use identifiable owned execution; the AI decision selects its mechanism and permissions. |

View locations are defaults: VS Code users can move and hide views. Do not promise fixed widths or automatic sidebar-width reclamation. Hiding or disposing a webview is not Exit Review. Commands remain reachable when the companion is hidden.

Source navigation carries repository/review identity, inspected source identity, comparison side, path and range. Return also carries the initiating concern and expansion/focus target. Renamed, deleted, outdated and unavailable sources retain their original identities. An unavailable target explains the limitation instead of opening an unrelated current line. Reuse existing ordinary tabs where appropriate and preserve the pre-review editor state for restoration; the Git/restoration decision owns its recovery protocol.

## Ownership, modules and dependency direction

Suggested initial layout; add files as features need them rather than generate empty layers:

```text
src/
  extension.ts              # starts the extension and connects its parts
  domain/                   # review identities and pure review rules
  application/              # review manager, actions and connection interfaces
  connections/              # storage, Git, GitHub, AI and execution implementations
  vscode/                   # commands, documents, native comments and view providers
  webviews/                 # React screens, components and Tailwind entry stylesheet
  shared/                   # transport data types and runtime message validators
```

The application calls small interfaces describing the outside work it needs. Connections implement those interfaces. The startup file supplies those implementations explicitly; a dependency-injection framework is unnecessary. The domain imports neither VS Code nor React nor a provider SDK. Application code imports domain rules and its interfaces, not concrete connections. Native integration and webviews call application actions; they do not own duplicate business rules. Shared transport modules contain serializable data and validators, without Node, VS Code or React imports.

For example, a pure function can determine which Reviewed marks no longer apply after a source comparison. An application action obtains the comparison, invokes the rule, coordinates saving and updates the views. Git code obtains the source facts; it does not decide human progress or publication policy.

Separate interfaces cover source access/preservation/restoration, private review storage, GitHub discussion/delivery, AI investigation and workbench execution. This chooses responsibility boundaries without choosing a Git mechanism, database, provider, agent framework or terminal implementation. Those remain their decision tickets' work.

## Requests, events and saving

Use an explicit, versioned request/event protocol. Each webview attachment has an instance identity and receives a fresh host projection when ready. Requests identify their action, request, account/review and target. Mutations include the expected relevant state or draft revision. The host validates the message at runtime; TypeScript checks alone cannot validate received data.

Use a finite action list and small shared TypeScript validators. Validate shapes, primitive types, identifiers, revisions, allowed targets and bounded payload sizes. Resolve repository paths and record targets through host-owned identities. A webview cannot request an arbitrary VS Code command, executable, filesystem path or publication operation. Large source/attachment content uses host-managed references and bounded loading, not arbitrary messages containing an entire repository. Concrete limits must be documented with the relevant storage/AI feature before enabling it; failures preserve input rather than truncate silently.

For typing, keep the visible input responsive and retain unacknowledged text while saving. Updates carry a draft identity and increasing edit revision. A late acknowledgment cannot mark a newer edit Saved or replace it with older text. The host emits Saving, acknowledged Saved, or Failed with a retryable original target; only actual persistence acknowledgment means saved on device. The storage decision defines write ordering, timing, crash guarantees, Close/Discard races and recovery.

The manager owns review/navigation projections, running operations and source applicability. React holds temporary display state and unacknowledged input; it does not become the durable record. Host restart reconstructs the manager from storage and reconciles external records. Webview getState/setState may help presentation recovery but is not the durable draft/history source. Do not rely on retainContextWhenHidden for correctness.

Manual navigation and permitted GitHub workflows must work when AI is unavailable. Reopening a view restores a projection; it does not rerun an investigation or resend feedback automatically. GitHub state changes only after explicit eligible actions and server reconciliation.

## Background work, Stop and late results

Tag background work with its operation/attempt, account/review, inspected source, relevant state generation and provider configuration where applicable. Check those identities before changing the active projection. An old answer cannot replace a newer answer or mark a new source examined. Preserve partial responses and the original user message; retry creates a new attempt rather than a duplicate user turn.

Use cooperative cancellation signals through application/connection boundaries and dispose listeners/streams when their owning operation ends. Stop requested, stopping, confirmed stopped, completed, failed and unknown are distinct outcomes. A cancellation request does not prove every child process stopped. Execution adapters must establish what happened on each supported OS; source-changing operations need operation-specific safe boundaries and recovery.

Navigation or view disposal does not discard an acknowledged draft, abandon an in-flight save or pretend a GitHub mutation was cancelled. Publication receipts and restoration outcomes must still be reconciled against their original durable operations even when the active view changed. Ignore stale presentation results, not real external outcomes.

Active-source Sync waits for workbench-owned verification to finish or be confirmed stopped; a merely requested Stop is insufficient. Discussion refresh remains independent. Source updates preserve unaffected progress and flag affected evidence under the PRD; the Git, storage and AI decisions supply the detailed contracts.

## Trust, content and credential boundaries

Declare untrustedWorkspaces unsupported and explain why within VS Code's existing trust mechanism. Check trust/environment at privileged entry points as well as hiding or disabling UI actions. Trust does not itself authorize publication or bypass normal command permissions.

Bundle React JavaScript, Tailwind output and permitted assets with the extension. Use webview resource URIs and narrow local resource roots. Default the content security policy to denying content, then allow only required packaged scripts/styles/assets. No browser/CDN Tailwind compiler or production development server. Keep inline executable code and unrestricted network connections out of webviews.

Treat repository content, GitHub comments, model output, Markdown and attachment text as untrusted data. Render through safe text/Markdown paths; disable raw executable HTML and arbitrary command/resource links. Generated overview action links use a narrow host-generated allowlist and stable record identifiers, kept separate from author/comment Markdown. Revalidate their original target when invoked. Do not claim rendering safety from a content policy alone.

GitHub authentication and the appropriate credential store remain host-side; provider-owned sign-in/credential handling is settled by the AI decision. Never put secrets in React props, webview state, review records or logs. Do not promise uniform keychain-strength storage on every Linux configuration.

Publication and merge capabilities belong to explicit human application actions, separately from model investigation tools. Do not pass GitHub publication credentials to a model runtime. An unrestricted model shell could bypass a superficial tool-name restriction; the AI decision must establish actual permission/credential isolation before enabling that execution path. This architecture does not declare an unverified sandbox safe.

## Tailwind and accessibility

Compile Tailwind at build time. Keep a small CSS entry for imports, semantic theme aliases and necessary base/focus/accessibility rules. Map semantic colours to VS Code variables with Tailwind's variable-alias support. Use complete, statically discoverable utility class names for status variants. Tailwind does not style native comment widgets or grant control over their placement.

Omit Tailwind Preflight and define a small deliberate base for controls and rendered text. Preflight resets headings/lists and other defaults; omitting it avoids applying that broad reset to Markdown by accident. This is a styling implementation choice within the accepted Tailwind approach, not a new visual design. Validate light/dark/high-contrast, visible focus, reduced motion, text zoom, narrow wrapping and semantic names. Colours never carry status alone.

Keyboard flows include navigation, inline thread toggles, Context/Chat tabs, source links/return, composer opening/Close/Escape and submission overlays. New results do not steal focus. Close preserves text; Discard and Publish remain explicit. The accepted bottom placement does not waive exact native header focus or source return behaviour.

## Build, package management and tests

Use pnpm 12.11.2 and commit pnpm-lock.yaml. Pin packageManager to pnpm@12.11.2 in package.json during bootstrap; CI uses pnpm install --frozen-lockfile. Keep one package at the repository root initially; a monorepo is unnecessary. Use pnpm exec and pnpm run for checked-in tools/scripts and document their commands with pnpm. pnpm 12 is a native executable with Node 24 compatibility; the selected Node line is still required by the compiler/test tools.

Use esbuild for a Node-targeted host bundle and browser-targeted React bundles, with vscode external to the host bundle. Run the TypeScript checker separately: esbuild transpiles TypeScript without type-checking. Generate packaged CSS with Tailwind CLI. Provide pnpm dev to watch code/styles, pnpm check for type checks, pnpm test for fast tests, pnpm test:host for desktop integration, pnpm build for a clean release build and pnpm package for the installer. These are the agreed future script names; this planning change creates neither scripts nor a lockfile. Vitest uses Vite internally for tests; a Vite production build or live server is not required.

Use Vitest for pure/application/protocol tests and React Testing Library with jsdom for component interactions. Use Microsoft's test-cli/test-electron with its compatible Mocha line for real VS Code integration. For the initially fully bundled extension, pnpm package runs pnpm run build followed by pnpm exec vsce package --no-dependencies. Verify VSIX contents/installability; disabling dependency discovery is correct only when every required runtime dependency/asset is actually bundled or explicitly copied. A later external/native runtime dependency requires revisiting that package rule.

Do not rely on a vscode:prepublish hook for this pipeline: the checked vsce version invokes that hook through npm (or Yarn) internally, irrespective of the outer pnpm command. An explicit pnpm build/package pipeline keeps the build under the selected package manager. Packaging does not publish to the Marketplace. Record esbuild's required postinstall build permission in pnpm's committed build settings and review any other install hooks in the resolved dependency tree; do not disable dependency-script restrictions globally to make installation pass. The inspected TypeScript/Tailwind platform packages have no install lifecycle hooks, so native binaries alone do not imply a script approval is needed.

The following initial versions were checked against official package metadata on 15 October 2026. Use these exact initial versions for the first bootstrap, then commit the actually resolved lockfile after installation/build verification. Upgrade deliberately and rerun the relevant checks; do not float all dependencies to latest.

| Purpose | Selected constraint / initial version | Compatibility boundary |
| --- | --- | --- |
| Developer and CI runtime | Node >=24.15.0 <25, current Node 24 LTS patch | Satisfies the checked build/test tools, including jsdom. End users do not separately install Node for the extension itself; later AI prerequisites are a separate choice. |
| Package manager | pnpm 12.11.2 | Pin the exact package manager; commit pnpm-lock.yaml and use a frozen lockfile in CI. |
| VS Code host | engines.vscode: ^1.141.2 | Intended stable 1.x floor; test 1.141.2 and then-current stable. This declares a target, not a guarantee about every future release. |
| Host type declarations | @types/vscode 1.140.0; @types/node 24.19.2 | The published VS Code declaration package trails the chosen runtime; 1.141.0 returned E404. Use the published conservative ceiling and compile actual API use. If a required API is missing, verify a published declaration update or supported approach; do not invent a package, patch in internal APIs or silently weaken the design. |
| Type checking | TypeScript 7.0.2 | Separate no-emit check; check actual TS configuration and esbuild output during bootstrap. |
| UI runtime | react and react-dom 19.3.1; their types 19.3.0 | Matching React/DOM runtime versions; bundle into the webview. |
| CSS build | tailwindcss and @tailwindcss/cli 4.3.3 | Matching compiler packages, development-only; ship the resulting CSS. |
| JavaScript build | esbuild 0.28.2 | Development-only native build tool. Bundle host as CommonJS for Node 24 with vscode external; target browser output conservatively for Chromium 150. Use standard TypeScript/JSX rather than runtime compiler features. |
| Fast tests | vitest 5.0.4; vite 8.3.4 | Vite is part of the test stack; its version fits Vitest's declared range. |
| React interactions | @testing-library/react 16.3.3; @testing-library/dom 10.4.2; jsdom 30.1.3 | React 19 and DOM Testing Library 10 satisfy the stated peers; jsdom raises the development Node 24 floor to 24.15. |
| Desktop host tests | @vscode/test-cli 0.0.15; @vscode/test-electron 3.1.0; mocha 11.7.6; @types/mocha 10.0.10 | Use the runner-compatible Mocha 11 line. Standalone latest Mocha 12 is outside this runner's declared dependency range. |
| Installer package | @vscode/vsce 4.0.0 | Development Node >=22; package separately from publication. Inspect VSIX contents and exclude source fixtures, credentials and compiler/test toolchains. |

VS Code 1.141.2 and 1.142.0 source both pin Electron 43.7.7. Its published runtime is Node 24.21.0 and Chromium 150.0.7871.250; the former agrees with the prior prototype's measured extension-host Node. This supports the selected Node/renderer target, including Tailwind v4's core Chrome 111 floor. Optional CSS utilities and actual renderer behaviour still need validation. These are pinned source/release facts, not a measurement on every OS or a promise that later VS Code keeps the same runtime.

Direct package-engine compatibility is evidence for the selected combination, not proof of a successful installation or working extension. Implementation must resolve and lock the dependency tree, build it and run the acceptance checks before calling it validated. Development Node and the Node/Chromium embedded in VS Code are different compatibility requirements. Build-time native compiler/scanner packages are not runtime requirements for extension users; later choices that add native runtime dependencies must revisit packaging and platform coverage.

## Required implementation validation

Target the selected minimum and current stable VS Code on local Windows, macOS and Linux. Run type checking, fast behaviour tests and host integration tests in CI; exercise the packaged VSIX. Record exact OS/architecture, VS Code, extension-host Node and renderer versions. Add an architecture to the advertised platform matrix only after the package works there, especially if later storage/AI choices introduce native runtime dependencies.

Initial validation matrix: local Windows x64, local Linux x64 and local macOS arm64, each on minimum and current stable VS Code. Only the bounded macOS arm64 prototype at the minimum has evidence today; all production-package cells remain untested. Additional CPU architectures require their own package/runtime checks before support is advertised. Follow the selected VS Code release's supported OS prerequisites rather than invent a broader operating-system compatibility claim.

Fast tests cover changed-source Reviewed marks, account/review/target isolation, reordered draft acknowledgments, malformed messages, disposal/recreation, partial answer retention, stale results and publication receipt routing. Component tests exercise actual typing, keyboard actions, save failures and recovery; they cannot prove native layout or assistive-technology behaviour.

Native acceptance checks cover original/current source, split/unified diffs, same-range thread coexistence, renamed/deleted/unavailable anchors, exact thread-header focus, source-link return and expanded state, keyboard/screen-reader paths, moved/hidden/resized views, zoom/themes/contrast and source-tab restoration. Check Restricted Mode and unsupported remote/virtual workspaces explicitly. Compare owned screens against Figma, including the bottom composer's approved styling/internal layout and the newly accepted overview discussion section.

The prior prototype established bounded behaviour on macOS only; it did not validate visual parity, all keyboard/screen-reader paths, exact native focus, Windows/Linux, production crash recovery or packaged production code. If stable APIs cannot meet another approved behaviour, pause that feature and bring the precise gap to the owner. Do not silently weaken it, use internal/proposed APIs or treat this architecture decision as permission to release the mismatch.

## Responsibilities left to the map

| Decision | What remains there |
| --- | --- |
| [Choose Git preservation and source synchronization contracts](https://github.com/kaneki003/code-review-workbench/issues/7) | Source identities/bytes, preservation strategy, checkout/Sync, safe fallback, editor/workspace restoration and recovery. |
| [Choose durable private state and recovery storage](https://github.com/kaneki003/code-review-workbench/issues/8) | Engine/location/schema, transactions/acknowledgments, migrations, corruption, clear/retention and multi-window ownership. |
| [Choose GitHub collaboration and delivery contracts](https://github.com/kaneki003/code-review-workbench/issues/9) | Account/API mechanics, complete discussion fetching, pending review reconciliation, publication/receipt checks and merge outcomes. |
| [Choose AI runtime and investigation contracts](https://github.com/kaneki003/code-review-workbench/issues/10) | Account-login-first Gemini/ChatGPT access and eligible runtime, parallel API support, tool permissions, process execution, streaming/context limits and credential isolation. |
| [Accept the technical design and first working milestone](https://github.com/kaneki003/code-review-workbench/issues/11) | Integrate accepted contracts into technical-design.md, cover FR01–FR20, define milestone acceptance checks and ordered implementation. |

## Evidence

- [Approved PRD](../product/PRD.md), [design precedence](README.md) and [current interaction contract](figma-interaction-contract.md).
- [Accepted native-host experiment and placement decision](https://github.com/kaneki003/code-review-workbench/issues/5#issuecomment-6190598100).
- [Stable host research resolution](https://github.com/kaneki003/code-review-workbench/issues/2#issuecomment-6189269783), [Git/GitHub research resolution](https://github.com/kaneki003/code-review-workbench/issues/3#issuecomment-6189270728) and [AI account-access research resolution](https://github.com/kaneki003/code-review-workbench/issues/4#issuecomment-6189271731).
- Official [extension-host](https://code.visualstudio.com/api/advanced-topics/extension-host), [webview](https://code.visualstudio.com/api/extension-guides/webview), [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension) and [testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension) documentation.
- Official [React model](https://react.dev/learn), [Tailwind CLI](https://tailwindcss.com/docs/installation/tailwind-cli), [theme aliases](https://tailwindcss.com/docs/theme#referencing-other-variables), [Preflight](https://tailwindcss.com/docs/preflight#disabling-preflight) and [class detection](https://tailwindcss.com/docs/detecting-classes-in-source-files).
- Package management: [pnpm installation/platform compatibility](https://pnpm.io/installation), [frozen installs](https://pnpm.io/cli/install#--frozen-lockfile), [package build approvals](https://pnpm.io/cli/approve-builds), [committed build settings](https://pnpm.io/settings/build#allowbuilds), [pnpm 12.11.2 metadata](https://registry.npmjs.org/pnpm/12.11.2), [vsce dependency-manager support](https://github.com/microsoft/vscode-vsce/blob/v4.0.0/README.md), [packaging flags](https://github.com/microsoft/vscode-vsce/blob/v4.0.0/src/main.ts#L121) and [prepublish implementation](https://github.com/microsoft/vscode-vsce/blob/v4.0.0/src/package.ts#L1942).
- Runtime evidence: VS Code [1.141.2 runtime pin](https://github.com/microsoft/vscode/blob/1.141.2/.npmrc), [1.142.0 runtime pin](https://github.com/microsoft/vscode/blob/1.142.0/.npmrc), [1.141.2 stable API declarations](https://github.com/microsoft/vscode/blob/1.141.2/src/vscode-dts/vscode.d.ts), [view contribution implementation](https://github.com/microsoft/vscode/blob/1.141.2/src/vs/workbench/api/browser/viewsExtensionPoint.ts), [Electron 43.7.7](https://releases.electronjs.org/release/v43.7.7) and [Tailwind compatibility](https://tailwindcss.com/docs/compatibility).
- Version metadata: [TypeScript](https://registry.npmjs.org/typescript/7.0.2), [React DOM](https://registry.npmjs.org/react-dom/19.3.1), [Tailwind CLI](https://registry.npmjs.org/@tailwindcss%2Fcli/4.3.3), [esbuild](https://registry.npmjs.org/esbuild/0.28.2), [Vitest](https://registry.npmjs.org/vitest/5.0.4), [Vite](https://registry.npmjs.org/vite/8.3.4), [React Testing Library](https://registry.npmjs.org/@testing-library%2Freact/16.3.3), [jsdom](https://registry.npmjs.org/jsdom/30.1.3), [VS Code test runner](https://registry.npmjs.org/@vscode%2Ftest-cli/0.0.15), [desktop test launcher](https://registry.npmjs.org/@vscode%2Ftest-electron/3.1.0), [vsce](https://registry.npmjs.org/@vscode%2Fvsce/4.0.0), [published VS Code types](https://registry.npmjs.org/@types%2Fvscode/1.140.0) and [Node 24 types](https://registry.npmjs.org/@types%2Fnode/24.19.2).

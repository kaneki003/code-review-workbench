# Code layout and dependency rules

The owner accepted responsibility-based organization on 22 October 2026. Folders identify engineering capabilities, with related implementations divided into cohesive files. This replaces the earlier global `connections/` and `shared/` source folders. The project remains one extension and one package.

## Source map

```text
src/
  extension.ts                 # creates implementations and wires the extension
  application/
    review-manager.ts          # coordinates account, source and checkout actions
    draft-writer.ts            # owns pending input and save scheduling
    draft-writer-protocol.ts   # handles browser attachment and writer messages
  domain/                      # checkout, source, draft and PR contracts/pure rules
  git/
    checkout.ts                # ordinary stash/switch/restore and checkout receipt
    committed-source.ts        # committed comparisons and exact-content reads
    repository.ts              # local repository discovery and identity
    readiness.ts               # installed Git capability probe
    repository-operation.ts    # existing guarded source operations, pending migration
    reference-storage.ts       # existing reference-path checks, pending migration
  github/
    pull-requests.ts            # GitHub requests and normalized PR responses
  storage/
    contracts.ts               # connection requests, replies and errors
    connection.ts              # host-to-worker connection
    worker.ts                  # existing persistence dispatch and coordination
    database.ts                # schema, transactions and request receipts
    drafts.ts                  # draft persistence
    records.ts                 # existing ownership records and validation
    location.ts                # private-store path resolution
    diagnostics.ts             # storage fault-injection support
    readiness.ts               # starts the SQLite capability probe
    readiness-worker.ts        # isolated in-memory SQLite probe
  native/
    readiness.ts               # native-helper capability probe
    probe-worker.ts            # isolated native loading
  protocol/                    # browser-safe draft/readiness messages and validators
  vscode/
    documents/                 # checkout saves, overview documents and source links
    views/                     # committed-source, draft and readiness integration
  webviews/
    drafts/                    # browser entry, client and React writer
    readiness/                 # browser entry and React readiness screen
    styles.css                 # shared Tailwind/theme stylesheet
```

`native/` at the repository root contains the C++ helper and its build definition; `src/native/` contains the TypeScript adapters that probe it. The global ownership/process implementation still exists pending the SQLite migration in ADR 0007. Moving its files does not complete that migration.

The manager and worker retain their existing behavior in this organization checkpoint. Further extraction of application actions is separate work. Add `vscode/commands/` or `vscode/comments/` only when there is an independently owned implementation to put there; do not generate empty folders or forwarding files.

## Dependency direction

- `domain/` contains identities, contracts and pure rules. It imports no VS Code, React, Node I/O, database or provider implementations.
- `application/` coordinates operations through their contracts. It does not construct concrete Git, GitHub, storage or host implementations.
- `git/`, `github/` and `storage/` own their respective external operations. Git command execution belongs in `git/`, including source operations still called by the storage worker during the migration.
- `protocol/` contains serializable messages and runtime validators. It may use pure domain rules, and must remain safe to bundle for a browser.
- `vscode/` owns native documents and view integration. `webviews/` owns browser interaction and rendering. Browser code must not import Node, VS Code, SQLite or provider implementations.
- `extension.ts` supplies implementations explicitly. There is no dependency-injection framework or required barrel export. Import the specific module being used.

The existing Git source-operation implementation still imports storage errors and ownership record helpers. Those are transitional dependencies, not a pattern for new Git operations. Preserve the existing behavior until the shared-storage migration removes that machinery. Likewise, relocating interfaces does not authorize moving host-owned review rules into a renderer.

Within each responsibility, share code when implementations have the same requirements. Checkout and committed-source reading remain separate files. Do not force their different command policies through a common runner merely because both execute Git.

## Test map

```text
tests/
  application/                 # manager, checkout ordering, source, drafts and selection
  git/                         # real disposable Git checkout behavior
  github/                      # controlled GitHub HTTP/auth responses
  storage/                     # SQLite/worker behavior and existing ownership coverage
  native/                      # native process and capability checks
  vscode/                      # native API adapters with a controlled host
  webviews/
    drafts/                    # React interactions backed by real Git/SQLite fixtures
    readiness/                 # rendering and host-message handling
  host/
    main.ts                    # explicit installed-VSIX suite entry and evidence hooks
    readiness.test.ts          # packaged readiness and reentry
    storage.test.ts            # installed storage and interrupted-host recovery
    overview.test.ts           # native Markdown overview
    review-flow.test.ts        # composed source/draft/checkout journey
    support.ts                 # host evidence types and repository helpers
    draft-writer.ts            # installed draft-interaction exercise
    draft-browser.ts           # Chromium interaction helper
  provider/
    github-read.ts             # separately authorized real-provider read fixture
  support/
    review/                    # disposable committed-review setup and cleanup
    storage/                   # shared store/repository setup and cleanup
    processes/                 # child-process entry points
```

Tests are grouped by the responsibility exercised. Their setup remains explicit: a manager test can use real Git and SQLite, and a jsdom test can still be integration-backed. `host/review-flow.test.ts` intentionally keeps one composed journey together because its draft and checkout assertions build on the source setup.

Vitest discovers the `.test.ts`/`.test.tsx` suites except `tests/host/`. The host runner bundles `tests/host/main.ts`, registers the same six installed scenarios in their existing order and writes one evidence record. Test support and provider entry points are not standalone Vitest suites.

## Running and packaging

```sh
pnpm validate
pnpm exec vitest run tests/git tests/application/checkout.test.ts
pnpm exec vitest run tests/application/drafts.test.ts tests/application/draft-writer.test.ts
pnpm test:host
CRW_VSCODE_VERSION=1.141.2 pnpm test:host
```

Native process fixtures need the OS capabilities provided by the ordinary development/test environment. Run native-building test and packaging commands sequentially: both use `native/build/`.

Source paths changed; packaged names did not. `scripts/build.mjs` still produces `extension.cjs`, `store-worker.cjs`, `readiness-worker.cjs`, `native-probe-worker.cjs`, `draft-writer.js`, `readiness.js` and `readiness.css`. Host webview/worker lookup therefore uses the same packaged paths. `scripts/test-provider.mjs` bundles the relocated provider entry. No package dependencies or public commands changed.

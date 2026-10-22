# Responsibility-based layout review

Reviewed on 22 October 2026 against `312a9ac`, the completed checkout deletion checkpoint. Implementation commit: `4d586cb`.

## Scope

The owner accepted engineering-responsibility folders in place of a generic feature tree and explicitly requested matching README/documentation updates. This checkpoint relocates existing implementations, separates mixed tests and updates entry points and references. The [layout guide](code-layout.md) is the current file map.

All 38 relocated production files were compared with the baseline after ignoring import-path and formatting differences; their implementation bodies are unchanged. The manager and storage worker retain their current behavior. Global ownership removal and further application decomposition remain separate work.

## Standards review

The automated standards review found no documented-standard breaches or actionable introduced code smells. It checked the explicit-import rule, pure domain contracts, browser-safe protocol dependencies and test-fixture cleanup registration. Transitional Git/storage coupling remains explicitly documented.

## Spec review

The automated spec review found the accepted responsibility grouping, relocated build/provider/process entries and all existing application-test titles preserved. It verified that the installed-host entry registers the same six scenarios in the same order with the shared evidence lifecycle.

One documentation mismatch was found: the readiness guide called the six-scenario entry “two tests.” Its link now points to the two readiness scenarios in `tests/host/readiness.test.ts`. No code correction was needed.

## Validation

- `pnpm validate`: formatting, TypeScript and all 185 tests passed across 16 Vitest suites. The count is unchanged from the baseline; additional suites result from splitting mixed files.
- `pnpm test:host`: all six installed scenarios passed on VS Code 1.143.0 / macOS arm64. This built and installed the VSIX, including relocated worker and browser bundles.
- `CRW_VSCODE_VERSION=1.141.2 pnpm test:host`: all six installed scenarios passed on the minimum supported version / macOS arm64.
- All updated current code/test links resolve; the fictional PR description's example `src/workers/worker.test.ts` is intentionally not a project file.

Public command IDs, package dependencies and packaged output filenames are unchanged. Cross-platform CI acceptance remains open; local results do not establish Windows or Linux support.

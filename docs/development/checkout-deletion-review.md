# Checkout deletion checkpoint review

Reviewed on 22 October 2026 against `17b20d5`, the ordinary Git checkout implementation. This checkpoint removes the obsolete checkout/editor cluster before the shared-storage migration.

## Standards

The automated standards review found one lost behavior: deleting the worker's checkout-journal guard allowed another PR candidate to replace the active selection. The manager now checks the repository-local checkout receipt and its retained source before saving a candidate. Selection shares the Enter/Exit queue so it cannot pass the check while Enter is still saving documents. Real-worker regression tests verify same-PR reopening, different-PR refusal, Exit, successful selection afterward and overlapping entry/selection. The followup standards review reported no remaining actionable concerns or lock-order cycle.

No other actionable standards findings were reported. The unused editor snapshot and manifest tests were removed with their retired implementation; current Git behavior is covered by checkout and manager tests.

## Spec

The automated spec review found no introduced deviations from the deletion checkpoint. ADR 0006 governs checkout, manual recovery and editor-state ownership. ADR 0007's shared SQLite migration remains intentionally pending; this checkpoint does not establish concurrent source/draft storage access across windows.

## Verification

- `pnpm validate`: formatting, TypeScript and all 185 tests passed after the review followup.
- The manager suite includes save cancellation, Git restoration, active-PR selection and overlapping entry/selection.
- `pnpm test:host`: six installed-host tests passed with each of VS Code 1.143.0 and minimum-supported 1.141.2 on macOS arm64, including normal document saving and Git restoration after manager recreation.
- Packaged VSIX built successfully as part of the host test.

The initial sandbox run could not inspect native macOS process identities. A later overlap between test and packaging builds removed the shared native output while tests were copying it. The sequential validation above passed outside the sandbox. These failed runs are not counted as product regressions or successful validation.

Cross-platform CI acceptance remains open. Earlier checkout/attribute review records describe retired code and remain historical evidence.

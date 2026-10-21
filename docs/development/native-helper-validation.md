# Historical native helper checkpoint (#18)

The owner approved the native helper on 17 October 2026. This checkpoint implements the OS lock, process identity, local-directory checks and packaged worker probe. The [helper walkthrough](shared-state-ownership.md#walk-through-the-helper) gives the reading order and build requirements. At this earlier checkpoint the canonical store and recovery files were unfinished. See the [current store checkpoint](shared-store-validation.md); review writes remain disabled.

## Tests

At `f6bbf47`, `pnpm validate` passed formatting, TypeScript and 21 tests on macOS arm64. Windows/Linux skip the one macOS-specific boot-session check. Tests were added at the accepted native/process and public-manager boundaries:

- Competing real processes: one guard holder; explicit release lets a successor enter; a stale repeated release cannot unlock it.
- Process death: exactly one of two contenders obtains the freed OS lock. This establishes lock lifetime, not safe application takeover or proof a child stopped.
- Worker termination: the enclosing process stays alive and another process can obtain the released worker's guard.
- Process identity: OS-provided start metadata distinguishes a child and no longer identifies it after death. macOS uses the boot-session UUID, checked against independent `sysctl` output.
- Filesystem: a canonical local folder passes; redirected/relative folders are refused.
- Public manager: the production helper loads in a real worker, missing-binary loading fails closed, and passing helper readiness leaves ownership blocked.

Both local installed-host tests also exercise the helper from the actual OS/CPU-specific VSIX outside the source checkout, with real React/SQLite probes and an unchanged disposable Git repository. Local host: macOS 25.6.0 arm64, VS Code 1.142.0, Node 24.21.0, Electron 43.7.7, Chromium 150.0.7871.250, SQLite 3.53.4, Git 2.56.0. Developer Node 24.22.0; pnpm 12.11.2.

The [first complete native-helper matrix](https://github.com/kaneki003/code-review-workbench/actions/runs/39018274176) passed all six Windows x64, Linux x64 and macOS arm64 cells at minimum/current VS Code (`218ea53`). The [corrected identity/cleanup revision](https://github.com/kaneki003/code-review-workbench/actions/runs/39018475244) also passed all six cells at `f6bbf47`, including both installed-host tests in every cell. [Measured host versions and package targets](native-helper-platforms.json) were extracted from those six uploaded evidence files and VSIX manifests, with helper Passed, ownership Blocked and review unavailable checked in each.

| OS / architecture | Actual OS release | VS Code             | Package target |
| ----------------- | ----------------- | ------------------- | -------------- |
| macOS arm64       | 24.6.0            | 1.141.2 and 1.142.0 | darwin-arm64   |
| Linux x64         | 6.17.0-1022-azure | 1.141.2 and 1.142.0 | linux-x64      |
| Windows x64       | 10.0.26100        | 1.141.2 and 1.142.0 | win32-x64      |

These checks do not establish power-loss durability, independent recovery publication, the filesystem allowlist on every volume, canonical registration, accounts/fencing or safe interrupted-owner reclamation. No system clock was changed during tests. The macOS clock-correction finding was established from Apple's source, then a regression verified the replacement boot-session component.

## Standards

Two findings resolved:

- The worker acknowledged success before its cleanup finished; immediate host termination could interrupt cleanup. Success is now posted after both guard release and temporary-directory removal.
- One sentence described the previous JavaScript-only package as current. It now identifies the earlier checkpoint accurately.

The separate reviewer rechecked the fixes and reported no remaining documented-standard violations or actionable smell heuristics. The most consequential initial finding was the acknowledgment/cleanup race.

## Spec

One P2 finding resolved: macOS identity used mutable boot wall-clock time. Apple's [clock adjustment](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/clock.c#L674-L751) changes that value. The helper now combines the [boot-session UUID generated at boot](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp#L3846-L3862), [exposed read-only](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c#L2735-L2737), with [recorded process-start metadata preserved across exec](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_fork.c#L1058-L1067). The regression failed before the fix and passed afterward.

The separate reviewer confirmed the fix and found no remaining actionable checkpoint regressions or unasked scope. #18 still requires one shared durable store and safe refusal/recovery across windows; this checkpoint does not complete that requirement.

Standards: 2 findings resolved, 0 open. Spec: 1 finding resolved, 0 actionable regressions open; full #18 ownership acceptance remains open.

# Superseded validation note

> These results cover the earlier native ownership/process helper. [ADR 0007](../adr/0007-coordinate-review-state-per-repository.md) removes it from the target architecture; retain this file only as historical evidence during migration.

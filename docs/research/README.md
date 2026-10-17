# Host-Feasibility Research

- [VS Code host patterns](vscode-host-patterns.md), checked 11 October 2026.
- [Inline comment feasibility](inline-comments-feasibility.md), checked 12 October 2026.

These are dated research records with primary-source links and stated evidence limits. Recheck relevant capabilities and compatibility before selecting implementation mechanisms. The [current UI contract](../design/figma-interaction-contract.md) incorporates the later selected interface treatment.

For the unresolved engineering work, start with [architecture questions and host checks](../design/interface-feasibility-questions.md).

## AI runtime evidence

The following notes were checked on 15 October 2026. They are documentation research, not implemented or tested connections:

- [Corrected subscription/account access](wayfinder-ai-runtime-access-check.md): declared proprietary distribution, current consumer-access restrictions and the later owner-approved API-key scope.
- [Gemini/OpenAI API runtime options](wayfinder-ai-api-runtime.md): direct AI SDK providers, models, streaming/history semantics and package metadata.
- [Owned command execution](wayfinder-ai-execution-runtime.md): MXC, offline containment, platform prerequisites and required capability checks.

The [accepted interim AI investigation contract](../design/ai-investigation.md), confirmed on 16 October, selects direct ChatGPT-plan requests for personal-local development planning with extension-owned tools/history, protected remembered logins, model switching and bounded recovery. API support remains separate and parallel. Actual authorization/inference, packaged dependencies and command containment remain unverified; public ChatGPT/Gemini eligibility and release reconciliation remain pending. Earlier research records describe the facts and candidate comparisons at their stated dates, not successful integration tests.

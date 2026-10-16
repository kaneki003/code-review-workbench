---
status: accepted
---

# Keep AI investigations and command permissions under local review ownership

Accepted by the owner on 16 October 2026 for interim personal-local development planning: keep conversation, attempts, source attribution and tool permissions under the local review manager, using direct ChatGPT-plan Responses requests with protected app-owned login and standard auth/request libraries. This avoids coordinating another Codex agent runtime with existing review ownership; the tradeoff is maintaining the small investigation loop and account lifecycle, including deliberate model changes between attempts with the same PR conversation retained. The [accepted investigation contract](../design/ai-investigation.md) also selects AI SDK Core for separate API-key connections, MXC for bounded offline checks with manual network/platform exceptions, and retained partial answers with explicit Retry/Continue.

The personal-local eligibility assumption for this particular proprietary product remains provisional; actual authorization/inference, dependency packaging and command containment remain validation gates. The coherent personal-local technical design was subsequently accepted separately; intended public ChatGPT/Gemini support still requires provider eligibility answers and the later [public-release design review](https://github.com/kaneki003/code-review-workbench/issues/14); accepting this ADR does not authorize public distribution.

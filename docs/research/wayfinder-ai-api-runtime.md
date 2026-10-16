# Gemini and GPT API runtime options

Latest owner instruction, 16 October 2026: ChatGPT/Gemini account-plan login is required first. API support may proceed in parallel and is not a substitute. This note describes that parallel API path; the account prerequisite is tracked in the [current access note](wayfinder-ai-runtime-access-check.md). The earlier API-first scope below is historical.

Checked 15 October 2026 for [Choose AI runtime and investigation contracts](https://github.com/kaneki003/code-review-workbench/issues/10). The owner subsequently **approved developer API keys for both Gemini and GPT**, replacing the earlier subscription-first requirement. Intended release: public extension, free trial initially, private source; one provider per investigation, deliberate switching and canonical conversation retained locally. The [subscription-access note](wayfinder-ai-runtime-access-check.md) remains historical eligibility evidence, not a blocker to this newly authorized API route.

This is documentation research and a recommendation, not an accepted runtime/model decision or successful integration. No packages installed, keys inspected, sign-in attempted or inference performed.

## Recommendation for one junior developer

Use **AI SDK Core with explicit direct OpenAI/Google provider instances**, inside a small Workbench-owned investigation runner. It offers a real simplification: one stream, tool declaration/result format, structured-output interface and bounded tool loop for both providers. Workbench still owns persistence, permissions, execution, cancellation and review freshness. Avoid adding a separate agent service or adopting framework UI/state as the product's canonical conversation.

| Option | Documented mechanism | Maintenance tradeoff — judgment |
| --- | --- | --- |
| Official `openai` + `@google/genai` | First-party clients, Responses / Gemini generation or Interactions APIs, native typed events/history | Closest to provider documentation and earliest feature support; Workbench must maintain two stream/history/tool serializers and a common loop. Good fallback if an adapter loses required metadata. |
| AI SDK Core `streamText` + direct adapters | Normalized stream parts, tool schemas/results, multi-step `stopWhen`, abort and provider options | Recommended starting point: less duplicate plumbing, explicit host control over investigation state; adds a third-party compatibility layer and coordinated package updates. |
| AI SDK `ToolLoopAgent` | Reusable model/tools/instructions/loop configuration | Saves repeated setup but does not provide durable Workbench recovery or command enforcement. Useful later if multiple agents reuse configuration; not necessary to start. |

AI SDK itself recommends `ToolLoopAgent` for general agents and core functions where explicit workflow control is needed. Both run locally in application code; this does not require Vercel hosting. [Agent overview](https://ai-sdk.dev/docs/agents/overview), [ToolLoopAgent reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent).

## Direct connections and keys

The official [OpenAI library guide](https://developers.openai.com/api/docs/libraries) documents the Node/TypeScript client with developer API authentication. Google's [Gen AI JavaScript SDK](https://googleapis.github.io/js-genai/release_docs/) supports Gemini Developer API keys and local Node execution. These developer API routes have separate billing/quotas from consumer assistant subscriptions; neither requires extracting CLI OAuth credentials.

AI SDK's [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai) accepts an explicit `apiKey` and defaults to the Responses API at OpenAI. Its [Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google) accepts an explicit `apiKey` and directly calls Google's API. **Bare model strings use AI Gateway by default.** Construct direct provider/model objects instead; no Gateway account or app-operated proxy is required for those direct interfaces.

Recommended key handling: collect each user's own key through a host-owned password input, retain it in `ExtensionContext.secrets`, pass it explicitly to that provider client, and offer replacement/removal. VS Code documents encrypted, platform-dependent SecretStorage that does not sync across machines. Keep keys out of SQLite review records, settings, logs, prompts, webviews and command environments. This is an application design, not protection against all software running as the same OS user. [VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage).

Google warns against shipping embedded developer keys in client applications. A user supplying their own key to a local extension is a different credential-ownership design; never bundle the extension author's key. Do not infer that browser examples make a webview suitable for permanent secrets. [Gemini key guidance](https://ai.google.dev/gemini-api/docs/api-key).

## Models: a small candidate list, remembered explicit selection

The following are documented model candidates, **not a tested or accepted support list**. Balanced default suggestions reflect provider descriptions and maintenance/cost judgment, not a Workbench benchmark.

| Provider / proposed role | Exact model ID | Documented token limits | Required capabilities |
| --- | --- | --- | --- |
| GPT balanced | `gpt-6.1-sol` | 1,050,000 context; 128,000 maximum output | Text, streaming, function calling and structured outputs; use Responses for tool calls |
| GPT optional stronger | `gpt-6-astra` | 1,050,000 context; 128,000 maximum output | Same required capabilities; higher published price |
| Gemini balanced | `gemini-3.8-flash` | 1,048,576 input; 65,536 output | Stable; text, function calling, structured outputs and thinking |
| Gemini optional stronger | `gemini-4-argon` | 1,048,576 **shared** input/thinking/output window; default synchronous output maximum 65,536 | Stable; text, function calling, structured outputs; long decode is a separate, avoidable feature |

Sources: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon). These model pages do not establish practical review quality, account access or that the whole window is useful for a PR. Set much smaller application budgets and expose omissions. A `latest` alias can change without a product update; prefer these explicit IDs.

OpenAI's model listing exposes available IDs/basic metadata, not a complete feature matrix. Gemini model metadata includes supported generation methods and input/output limits. Intersect discovered availability with the implementation's small validated list; catalog presence alone does not prove a successful request or every required feature. Remember the chosen model per provider and record the actual provider/model on each attempt. If unavailable, explain and request deliberate selection rather than silently switching. [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list), [Gemini models metadata](https://ai.google.dev/api/models).

## Streaming, tools and structured suggestions

OpenAI Responses streams typed text, tool-argument and terminal events. The application executes declared functions and returns their results; a model requesting a function is not permission to run it. Native Gemini clients likewise expose generation streams and function calls/results. Fully collect and validate a tool's arguments before executing it. [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [OpenAI functions](https://developers.openai.com/api/docs/guides/function-calling), [Google function calling](https://ai.google.dev/gemini-api/docs/function-calling).

AI SDK normalizes text/tool/error/finish stream parts and supports `stopWhen` for repeated tool-result/model steps. Its current v7 docs call the step condition `isStepCount`; do not copy older version examples blindly. Manual approval yields approval-request parts and a subsequent continuation; it is not a durable blocking process. Workbench must persist that state. Provider-executed tools bypass local tool approvals, so the initial registry should expose only Workbench-owned investigation tools. [Core streaming](https://ai-sdk.dev/docs/ai-sdk-core/generating-text), [tools, loops and approvals](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).

Both providers support schema-constrained answers, with schema subsets and refusal/truncation cases. Validate completed suggestions locally, including source IDs/ranges and evidence. Partial JSON remains incomplete output; syntactic schema compliance does not establish a correct finding. Plain conversation need not be forced into the suggestion schema. [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).

## Stop, errors and retry

AI SDK Core takes `abortSignal` and exposes abort/error parts. Its `onAbort.steps` contains **completed** steps; persisting only that callback can lose text already emitted by the interrupted current step. Persist incoming deltas through the host's ordered save path and finalize the attempt separately. Propagate the same cancellation to Workbench-owned tools/process groups and block new calls after Stop. [Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams).

The official OpenAI SDK supports request `signal` and retries some failures twice by default. Its default timeout is ten minutes. Configure these explicitly rather than stacking invisible SDK and application retries. [SDK cancellation/retries](https://raw.githubusercontent.com/openai/openai-node/master/README.md). Google's request configuration explicitly warns that AbortSignal only cancels the client operation: the service can continue and applicable usage is still charged. Do not promise that pressing Stop eliminates provider-side work or cost. [Google request configuration](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html).

Recommended application behavior: distinguish invalid key, permission/model access, quota/billing, rate limit, network, refusal, incomplete output and cancellation. Preserve visible partial output and one user-message identity across attempts. Retry from a recorded safe boundary; never blindly repeat a tool with an uncertain external result. Do not auto-switch provider or credentials after failure. Usage is provider-reported token data when available; interrupted streams can leave cost/usage unknown. OpenAI limits vary with account tier; Gemini limits are project/tier based, so multiple keys need not provide independent quota. [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Local history, switching and compaction

OpenAI supports explicit replayable input history with `store:false`; retain necessary output/reasoning items rather than only rendered text. Gemini stateless Interactions likewise requires returned thought blocks/signatures to be sent back unchanged. These are provider-specific continuation records, not human-readable shared memory. [OpenAI history](https://developers.openai.com/api/docs/guides/conversation-state), [Gemini thinking/signatures](https://ai.google.dev/gemini-api/docs/thinking).

AI SDK exposes OpenAI encrypted reasoning metadata and Google Interactions signature metadata for round-tripping. Preserve the chosen adapter's complete supported message parts/metadata in a versioned provider-local projection; do not flatten a continuation into role/text strings. Persisting that projection is separate from the canonical Workbench chat. On a deliberate provider change, build a new projection from visible conversation, decisions and current evidence; do not send another provider's opaque continuation data. [OpenAI adapter metadata](https://ai-sdk.dev/providers/ai-sdk-providers/openai#typed-providermetadata-in-reasoning-parts), [Google adapter metadata](https://ai-sdk.dev/providers/ai-sdk-providers/google#provider-metadata).

OpenAI has native Responses compaction, including a `store:false` mode, but its compressed state is opaque and provider-specific. For first release, a common bounded context builder with explicit summaries, source references, omitted-scope flags and protected recent tool groups is easier to reason about across providers. Keep the full canonical local conversation when trimming model input. Native compaction can be an adapter optimization later. [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).

## Package evidence and remaining validation

Subsequent registry check on 15 October: read-only `npm view` queries confirmed publication of `ai` 7.0.141, `@ai-sdk/openai` 4.0.93, `@ai-sdk/google` 4.0.96, `zod` 4.1.8 and `@microsoft/mxc-sdk` 1.0.0, with the engines/peer compatibility stated in the [proposed contract](../design/ai-investigation.md). These are proposed bootstrap pins, not a resolved lockfile or installation/runtime test. The source-manifest observations below preceded that registry verification.

Observed upstream **source manifests**, not registry-verified release pins:

| Package | Manifest version | Declared Node engine | Source |
| --- | --- | --- | --- |
| `openai` | 7.34.0 | >=22 | [manifest](https://raw.githubusercontent.com/openai/openai-node/master/package.json) |
| `@google/genai` | 2.30.0 | >=20 | [manifest](https://raw.githubusercontent.com/googleapis/js-genai/main/package.json) |
| `ai` | 7.0.141 | >=22 | [manifest](https://raw.githubusercontent.com/vercel/ai/main/packages/ai/package.json) |
| `@ai-sdk/openai` | 4.0.93 | >=22 | [manifest](https://raw.githubusercontent.com/vercel/ai/main/packages/openai/package.json) |
| `@ai-sdk/google` | 4.0.96 | >=22 | [manifest](https://raw.githubusercontent.com/vercel/ai/main/packages/google/package.json) |

All declared engines include the selected Node 24 host. AI SDK manifests declare Zod peers `^3.25.76 || ^4.1.8`; registry publication, the exact resolved dependency graph, bundling and runtime compatibility were not tested. Google also warns of upcoming SDK 3 changes to automatic function calling and Node requirements. Pin verified compatible packages when implementing; do not turn these mutable source snapshots into an accepted lockfile.

The bounded implementation checks should cover both providers: streamed text and function round-trip; retained text after Stop; tool cancellation and denied/revoked grants; serialized metadata after restart; structured suggestion refusal/truncation; model/quota/auth failure; explicit switching; stale-event rejection after review/source changes; and packaged Node 24 execution. Terminal permissions, GitHub credential isolation, inspectable/revocable grants and human-only publication remain application responsibilities under the approved product contract, whichever library is chosen.

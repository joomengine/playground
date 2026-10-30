# AI API integration validation

Implementation review: 30 October 2026. This document records engineering coverage; it is not a claim that every provider account has been connected successfully.

## Implemented contracts

`src/code/ai-provider-registry.mjs` is the ordered, non-secret catalog. `createChatProvider` is self-contained so the credential sandbox can install its exact implementation without importing an owner-realm credential object. It offers `stream`, `listModels`, and `dispose`. Provider settings and their keys stay inside that sandbox.

| Preset | Generation adapter | Model selection |
| --- | --- | --- |
| OpenAI | Responses, including function calls and encrypted reasoning replay | `/v1/models`, filtered text models and maintained preferences |
| Anthropic / Claude | Native Messages with browser opt-in headers; tool results and signed thinking replay | Paginated `/v1/models` |
| Google / Gemini | Native streaming GenerateContent; function IDs and thought signatures retained | Paginated `/v1beta/models`, generation-capable entries |
| DeepSeek, xAI, Mistral, Meta, Moonshot, Groq, Cerebras, Together AI | Chat Completions; streamed tools and reasoning continuation | Their documented compatible model catalogs |
| Cohere | Native `/v2/chat` event stream, tool plan/call/result messages | Paginated `/v1/models?endpoint=chat` |
| Alibaba / Qwen | Workspace and region-specific Chat Completions | Regional `/api/v1/models`, page-number pagination and capability filters |
| Z.ai / GLM | General Chat Completions endpoint | Published model fallback plus editable ID; no guessed list endpoint |
| MiniMax | Chat Completions, preserving reasoning content and complete response content | Published model fallback plus editable ID |
| Perplexity | Native `/v1/agent`, Responses-style streaming and custom functions | `/v1/models`; no automatic switch to private Orchestrator APIs |
| Fireworks | Inference Chat Completions | Paginated account catalog; only entries explicitly reporting serverless availability are offered |
| OpenRouter | Chat Completions gateway, exact signed/encrypted reasoning sequence replay | `/models`, text/tool filters |
| Hugging Face Inference Providers | Routed Chat Completions | `/models`, text and live tool-capable provider filters |
| NVIDIA hosted APIs | Hosted Chat Completions | Published model fallback plus editable ID; self-hosted NIM uses Other |
| Azure / Foundry | Resource-specific v1 Chat Completions using `api-key` | Resource v1 models; editable deployment ID |
| Bedrock | Explicit Runtime, Mantle `/v1`, or Mantle `/openai/v1` route using a Bedrock API key | Mantle catalog always `/v1/models`; Runtime has native foundation-model/profile discovery using optional AWS SigV4 credentials, plus manual IDs |
| Other / Local AI API | User-selected Chat Completions, Responses, Messages, Gemini, or Cohere format | Native format catalog; optional credentials and editable model ID |

Standard presets derive endpoints internally. Changing a named preset's visible settings cannot substitute an arbitrary base URL. Other accepts HTTPS and explicit local/private HTTP addresses; its HTTP support does not bypass browser mixed-content, local-network permission, or CORS rules. No local ports are probed automatically, no proxy is added, and redirects are rejected before credentials can be forwarded.

Model listing performs only GET requests. It has bounded bytes, pages and entries, rejects repeated or missing cursors, preserves a still-available selection, and uses preference rules after capability filtering. Where discovery is unavailable, a catalog/manual result is distinguished from a successful live connection.

Every adapter checks terminal events before returning tool calls. Truncated, cancelled, oversized, invalid, or failed streams produce no completed proposal. Request/error bodies, authentication headers and nested network causes are not forwarded in errors. Provider-native continuation fields stay in the isolated conversation and do not become executable project instructions.

## Automated evidence

Run:

```sh
node --test test/code-ai-providers.test.mjs test/code-ai.test.mjs
```

The provider suite covers:

- Complete ordered registry and a serialized factory with no imported dependencies.
- Optional local authentication and protection against named-provider URL substitution.
- Fragmented UTF-8 SSE, text, function arguments, and continuation history for all six protocol families.
- Anthropic signed blocks, Gemini function IDs/thought signatures, Cohere tool plans, Responses encrypted output replay, and compatible reasoning replay.
- Cancellation, provider failures, truncation and error-body redaction for native adapters.
- Anthropic, Google, Cohere, Qwen and Fireworks pagination, regional routing, capability filtering, and retained selections.
- Bedrock inference/catalog route separation; static/manual discovery without fictitious `/models` calls.
- Bedrock native discovery signed with WebCrypto; fixed signatures independently checked with curl's SigV4 implementation, temporary session tokens, encoded pagination cursors, model/profile filtering, cancellation and secret redaction.
- API-key authentication for Azure and independent compatible/local authentication.

These tests use protocol fixtures. They verify implemented behavior without generating paid completions. Existing AI review tests separately exercise bounded workspace access, dirty-buffer protection, review/accept/reject and recoverable writes.

## Remaining real-service checks

No provider API keys were supplied for this implementation. Authenticated catalog, generation, tools, quota and cancellation checks against real cloud accounts have **not** been run. A passing fixture does not establish that a provider allows the browser's opaque `Origin: null`, or that a particular account has the model enabled. Chromium/Firefox checks against deployed HTTPS Playground with one actual provider and a configured Ollama/LM Studio endpoint remain necessary before claiming live compatibility.

Bedrock Runtime has no compatible model-list endpoint. Optional AWS access-key ID, secret access key and temporary session token enable native `ListFoundationModels` and paginated `ListInferenceProfiles` calls. These credentials stay in the opaque session vault; secrets and tokens are masked, excluded from public connection identity, cleared when endpoint routing changes, and never used as bearer chat credentials. WebCrypto signs read-only catalog requests for the selected region. The AWS principal needs `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles`; actual IAM permissions, expiry, clock skew and browser CORS remain live-account checks that were not run.

Native Runtime listings filter inactive, non-text and non-streaming models, list on-demand foundation IDs and active profiles targeting known suitable models, and retain explicit manual IDs. AWS's native catalog does not state Chat Completions or tool support, so it does not automatically select an unknown-capability model: confirm the model card before choosing. Profiles whose underlying models are absent from the regional catalog remain manual. With no AWS discovery credentials, Runtime keeps manual model/profile entry; Mantle uses its own compatible catalog. No Runtime model is silently rerouted to Mantle. Dedicated Fireworks deployments and Azure deployment aliases also remain explicit manual IDs rather than an inferred callable catalog entry.

## Official references rechecked

- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create), [models](https://developers.openai.com/api/reference/resources/models/methods/list).
- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [models](https://platform.claude.com/docs/en/api/models/list).
- [Gemini GenerateContent](https://ai.google.dev/api/generate-content), [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).
- [Cohere streaming](https://docs.cohere.com/v2/reference/chat-stream), [models](https://docs.cohere.com/v2/reference/list-models).
- [DeepSeek continuation](https://api-docs.deepseek.com/guides/thinking_mode/), [MiniMax compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api).
- [Perplexity Agent](https://docs.perplexity.ai/api-reference/agent-post), [streaming](https://docs.perplexity.ai/docs/agent-api/output-control), [models](https://docs.perplexity.ai/api-reference/models-get).
- [Qwen compatibility](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [regional catalogs](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/list-models).
- [Meta API](https://dev.meta.ai/docs/api-reference), [Mistral models](https://docs.mistral.ai/api/endpoint/models), [Z.ai general API](https://docs.z.ai/api-reference/introduction).
- [xAI models](https://docs.x.ai/developers/rest-api-reference/inference/models), [Kimi models](https://platform.kimi.ai/docs/api/list-models), [Groq API](https://console.groq.com/docs/api-reference), [Cerebras models](https://inference-docs.cerebras.ai/api-reference/models/list-models), [Together compatibility](https://docs.together.ai/docs/inference/openai-compatibility).
- [Fireworks models](https://docs.fireworks.ai/api-reference/list-models), [Hugging Face router catalog](https://huggingface.co/docs/inference-providers/hub-api), [NVIDIA hosted APIs](https://docs.api.nvidia.com/nim/reference/llm-apis), [Azure models](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models).
- [Bedrock endpoint routing](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html), [discovery distinction](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html).
- [Bedrock foundation catalog](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html), [inference profiles](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html), [AWS Signature Version 4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html).
- [OpenRouter reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
- [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat).

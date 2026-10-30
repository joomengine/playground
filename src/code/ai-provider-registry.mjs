/**
 * Public configuration only. Credentials never belong in this registry.
 * Protocol and catalog routes are verified separately; see docs/roadmap/ai-validation.md.
 */
const preset = (id, label, baseURL, options = {}) => Object.freeze({
  id, label, baseURL, protocol: 'openai', auth: 'bearer', catalog: 'openai',
  fields: [], preferences: ['coder', 'code', 'instruct', 'chat'], ...options,
});
const regions = [
  ['ap-southeast-1', 'Singapore'], ['cn-beijing', 'China (Beijing)'], ['cn-hongkong', 'China (Hong Kong)'],
  ['eu-central-1', 'Germany (Frankfurt)'], ['ap-northeast-1', 'Japan (Tokyo)'], ['us-east-1', 'US (Virginia)'],
].map(([value, label]) => ({ value, label }));
export const AI_PROVIDERS = Object.freeze([
  preset('openai', 'OpenAI', 'https://api.openai.com/v1', {
    protocol: 'responses',
    preferences: ['gpt-6-sol', 'gpt-6', 'gpt-5.6', 'gpt-5', 'gpt-4.1'],
    documentation: 'https://developers.openai.com/api/reference/resources/models/methods/list',
  }),
  preset('anthropic', 'Anthropic / Claude', 'https://api.anthropic.com', {
    protocol: 'anthropic', apiVersion: '2026-10-21', auth: 'anthropic', catalog: 'anthropic', preferences: ['claude-sonnet', 'claude-opus', 'claude-haiku'],
    documentation: 'https://platform.claude.com/docs/en/api/models/list',
  }),
  preset('google', 'Google / Gemini', 'https://generativelanguage.googleapis.com/v1beta', {
    protocol: 'gemini', auth: 'google', catalog: 'gemini', preferences: ['gemini-4', 'gemini-3', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    documentation: 'https://ai.google.dev/api/models',
  }),
  preset('deepseek', 'DeepSeek', 'https://api.deepseek.com', { preferences: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'] }),
  preset('xai', 'xAI / Grok', 'https://api.x.ai/v1', { preferences: ['grok-4', 'grok-code'] }),
  preset('mistral', 'Mistral AI', 'https://api.mistral.ai/v1', { preferences: ['devstral', 'mistral-large', 'mistral-medium'] }),
  preset('meta', 'Meta', 'https://api.meta.ai/v1'),
  preset('cohere', 'Cohere', 'https://api.cohere.com', {
    protocol: 'cohere', catalog: 'cohere', preferences: ['command-a-plus', 'command-a', 'command-r-plus'],
    documentation: 'https://docs.cohere.com/v2/reference/chat-stream',
  }),
  preset('qwen', 'Alibaba Cloud / Qwen', '', {
    catalog: 'qwen', fields: [
      { id: 'region', label: 'Region', options: regions, default: 'ap-southeast-1', required: true },
      { id: 'workspaceId', label: 'Workspace ID', required: true },
    ], preferences: ['qwen3-coder', 'qwen3.8', 'qwen-plus', 'qwen-max'],
    description: 'Use the region and workspace belonging to your API key.',
    documentation: 'https://www.alibabacloud.com/help/en/model-studio/list-models',
  }),
  preset('moonshot', 'Moonshot AI / Kimi', 'https://api.moonshot.ai/v1', { preferences: ['kimi-k3', 'kimi-k2', 'moonshot'] }),
  preset('zai', 'Z.ai / GLM', 'https://api.z.ai/api/paas/v4', {
    catalog: 'static', models: ['glm-5.3'], description: 'Published general API model catalog. Coding-plan endpoints use a separate connection.',
    documentation: 'https://docs.z.ai/api-reference/introduction',
  }),
  preset('minimax', 'MiniMax', 'https://api.minimax.io/v1', {
    catalog: 'static', models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'], preferences: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    description: 'The published model catalog is available below; account availability can differ.',
    documentation: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
  }),
  preset('perplexity', 'Perplexity', 'https://api.perplexity.ai', {
    protocol: 'agent', catalog: 'agent', preferences: ['anthropic/claude-sonnet', 'openai/gpt-6-sol', 'google/gemini'],
    documentation: 'https://docs.perplexity.ai/api-reference/agent-post',
  }),
  preset('groq', 'Groq', 'https://api.groq.com/openai/v1'),
  preset('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'),
  preset('together', 'Together AI', 'https://api.together.ai/v1'),
  preset('fireworks', 'Fireworks AI', 'https://api.fireworks.ai/inference/v1', {
    catalog: 'fireworks', fields: [{ id: 'accountId', label: 'Account ID', required: true }],
    description: 'Lists serverless models from your account catalog. Dedicated deployments require their model ID.',
    documentation: 'https://docs.fireworks.ai/api-reference/list-models',
  }),
  preset('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', {
    description: 'Optional gateway that routes requests to multiple AI providers.',
    preferences: ['anthropic/claude-sonnet', 'openai/gpt-6-sol', 'qwen/qwen3-coder'],
    documentation: 'https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties',
  }),
  preset('huggingface', 'Hugging Face Inference Providers', 'https://router.huggingface.co/v1', {
    description: 'Hosted routing through Hugging Face Inference Providers.',
  }),
  preset('nvidia', 'NVIDIA hosted AI APIs / NIM', 'https://integrate.api.nvidia.com/v1', {
    catalog: 'static', models: ['nvidia/nemotron-3-super-120b-a12b', 'deepseek-ai/deepseek-v4-pro', 'moonshotai/kimi-k3'],
    description: 'Published hosted model catalog. Self-hosted NIM servers use Other / Local AI API.',
    documentation: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
  }),
  preset('azure', 'Microsoft Azure / Foundry', '', {
    auth: 'azure', fields: [{ id: 'resource', label: 'Azure resource name', required: true }],
    description: 'Use your deployment name as the model ID when it differs from the catalog model name.',
    documentation: 'https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/models',
  }),
  preset('bedrock', 'Amazon Bedrock', '', {
    catalog: 'bedrock', fields: [
      { id: 'region', label: 'Region', default: 'us-east-1', required: true },
      { id: 'route', label: 'Bedrock endpoint', default: 'mantle', options: [
        { value: 'mantle', label: 'Mantle — model catalog and /v1 inference' },
        { value: 'mantle-openai', label: 'Mantle — /openai/v1 inference' },
        { value: 'runtime', label: 'Runtime — manual model or inference profile ID' },
      ] },
    ], description: 'Use a Bedrock API key. Select the endpoint required by your model card; Runtime has no API-key model catalog.',
    documentation: 'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html',
  }),
  preset('other', 'Other / Local AI API', '', {
    auth: 'optional', description: 'Connect your own API server. Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1',
  }),
]);

// Retained export name for callers migrating from the former single candidate.
export const AI_PROVIDER_CANDIDATES = AI_PROVIDERS;

/** The settings UI translates these keys before serializing public configuration. */
export const AI_PROVIDER_MESSAGES = Object.freeze(Object.fromEntries(AI_PROVIDERS.flatMap(provider => [
  ...(provider.id === 'other' ? [['code.aiProvider.other', provider.label]] : []),
  ...(provider.description ? [[`code.aiProvider.${provider.id}.description`, provider.description]] : []),
  ...provider.fields.flatMap(field => [
    [`code.aiProvider.field.${field.id}`, field.label],
    ...(field.options || []).map(option => [`code.aiProvider.option.${option.value}`, option.label]),
  ]),
])));

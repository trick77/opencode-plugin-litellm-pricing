// Stands in for the LiteLLM proxy so the probe exercises the real discovery
// path under real opencode startup conditions without touching a remote host.
import { createServer } from 'node:http'

// Shaped like current LiteLLM (v1.96.0+): /v1/models carries `mode` and the
// token limits, but never cost.
const MODELS = [
  { id: 'ai-gateway-gpt-5.4', object: 'model', created: 1677610602, owned_by: 'openai', mode: 'chat' },
  { id: 'ai-gateway-gpt-5.4-mini', object: 'model', mode: 'chat' },
  { id: 'ai-gateway-text-embedding-3-small', object: 'model', mode: 'embedding' },
  // Non-chat, and NOTHING in the id says so — no `embed`, no `dall-e`, no
  // `whisper`. Only `mode` can keep it out of the picker.
  { id: 'ai-gateway-veo-3.1', object: 'model', mode: 'video_generation' },
]

// /v1/model/info: one row per deployment, `model_info` carrying LiteLLM's
// resolved price-map entry. This is where every price comes from.
const MODEL_INFO = {
  data: [
    {
      model_name: 'ai-gateway-gpt-5.4',
      litellm_params: { model: 'azure/gpt-5.4' },
      model_info: {
        mode: 'chat',
        max_input_tokens: 922000,
        max_output_tokens: 128000,
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000015,
        supports_function_calling: true,
        supports_vision: true,
      },
    },
    {
      model_name: 'ai-gateway-gpt-5.4-mini',
      litellm_params: { model: 'azure/gpt-5.4-mini' },
      model_info: {
        mode: 'chat',
        max_input_tokens: 922000,
        max_output_tokens: 128000,
        input_cost_per_token: 0.00000025,
        output_cost_per_token: 0.000002,
      },
    },
    {
      model_name: 'ai-gateway-text-embedding-3-small',
      model_info: { mode: 'embedding', input_cost_per_token: 0.00000002 },
    },
    { model_name: 'ai-gateway-veo-3.1', model_info: { mode: 'video_generation' } },
  ],
}

createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  // Checked first: `/v1/model/info` also starts with `/v1/model`.
  if (req.url?.startsWith('/v1/model/info')) {
    res.end(JSON.stringify(MODEL_INFO))
    return
  }
  if (req.url?.startsWith('/v1/models')) {
    res.end(JSON.stringify({ data: MODELS }))
    return
  }
  // Anything else — /v2/model/info included, which the plugin must never call
  // because LiteLLM still gates it behind an elevated key.
  res.statusCode = 404
  res.end('{}')
}).listen(7801, '127.0.0.1')

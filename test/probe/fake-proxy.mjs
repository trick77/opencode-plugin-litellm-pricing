// Stands in for the LiteLLM proxy so the probe exercises the catalog path
// under real opencode startup conditions without touching a remote host.
import { createServer } from 'node:http'

const MODELS = [
  { id: 'ai-gateway-gpt-5.4', object: 'model', created: 1677610602, owned_by: 'openai' },
  { id: 'ai-gateway-gpt-5.4-mini', object: 'model' },
  { id: 'ai-gateway-text-embedding-3-small', object: 'model' },
  // Non-chat, and NOTHING in the id says so — no `embed`, no `dall-e`, no
  // `whisper`. Only the catalog's `mode` can keep it out of the picker.
  { id: 'ai-gateway-veo-3.1', object: 'model' },
]

// A price table in LiteLLM's published format, served locally so the probe
// never reaches out to a remote host. `mode` is present on real entries, and
// is the field that classifies when /model_group/info is unreadable.
const PRICE_TABLE = {
  'azure/gpt-5.4': {
    litellm_provider: 'azure',
    mode: 'chat',
    max_input_tokens: 922000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.000015,
  },
  'azure/gpt-5.4-mini': {
    litellm_provider: 'azure',
    mode: 'chat',
    max_input_tokens: 922000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000025,
    output_cost_per_token: 0.000002,
  },
  'azure/text-embedding-3-small': {
    litellm_provider: 'azure',
    mode: 'embedding',
    input_cost_per_token: 0.00000002,
  },
  'ai-gateway-veo-3.1': { litellm_provider: 'ai-gateway', mode: 'video_generation' },
}

createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url?.startsWith('/v1/models')) {
    res.end(JSON.stringify({ data: MODELS }))
    return
  }
  if (req.url?.startsWith('/price-table.json')) {
    res.end(JSON.stringify(PRICE_TABLE))
    return
  }
  // /model_group/info deliberately 404s — LiteLLM closes that route to any key
  // created as `key_type: "llm_api"`, so the degraded path is the common one.
  res.statusCode = 404
  res.end('{}')
}).listen(7801, '127.0.0.1')

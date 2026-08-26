// Core types for the opencode-plugin-litellm-pricing plugin.
//
// Models the subset of LiteLLM's OpenAI-compatible /v1/models and
// /v1/model/info payloads the plugin needs — including the price-map entry
// shape the cost fields for opencode's per-model `cost` block are read from.

/**
 * A single model entry returned by LiteLLM's `/v1/models` endpoint.
 *
 * LiteLLM follows the OpenAI-compatible schema and adds a few fields of its
 * own. Current LiteLLM emits `mode`, `max_input_tokens` and `max_output_tokens`
 * here (see `create_model_info_response` in litellm/proxy/utils.py); older
 * proxies return `{id, object, created, owned_by}` alone. It never carries
 * cost. Everything missing is overlaid from `/v1/model/info` by `enrichModel`.
 */
export interface LiteLLMModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  /** LiteLLM-specific: underlying provider (e.g. "openai", "azure"). */
  litellm_provider?: string
  /**
   * LiteLLM `mode` — see {@link LITELLM_CHAT_MODES} for the documented values.
   * Emitted by `/v1/models` on current LiteLLM, absent on older proxies; also
   * carried by every `/v1/model/info` entry.
   */
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
}

export interface LiteLLMModelsResponse {
  object: string
  data: LiteLLMModel[]
}

/**
 * A LiteLLM price-map entry: `mode`, token limits, capability flags, and —
 * the reason this plugin exists — per-token cost fields.
 *
 * Field names follow LiteLLM's `model_prices_and_context_window.json`, which
 * is exactly the shape of the `model_info` block `/v1/model/info` returns —
 * the proxy resolves the entry itself and merges any config-level overrides
 * on top. Cost values are USD **per token**; opencode expects USD **per
 * 1,000,000 tokens**, so the cost mapper scales them by 1e6.
 *
 * Two readers: `buildCost` (the cost fields) and `enrichModel` (everything
 * else, overlaid onto a lean `/v1/models` entry).
 */
export interface LiteLLMModelInfo {
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
  // --- cost (USD per token) ---
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
  // Tiered pricing above a 200k-token context. LiteLLM also exposes
  // *_above_272k_tokens for some Azure/OpenAI models, but opencode only
  // models a fixed 200k boundary, so we map only the matching 200k tier.
  input_cost_per_token_above_200k_tokens?: number | null
  output_cost_per_token_above_200k_tokens?: number | null
  cache_read_input_token_cost_above_200k_tokens?: number | null
  cache_creation_input_token_cost_above_200k_tokens?: number | null
}

/**
 * A single row of LiteLLM's `/v1/model/info` response.
 *
 * One row per **deployment**, not per model group, so several rows can share a
 * `model_name` — that string is the public model-group name, which is exactly
 * the id `/v1/models` reports, so no alias resolution is needed.
 *
 * `litellm_params` and the rest of the deployment record are returned too (with
 * credentials stripped by the proxy) and deliberately not declared: the plugin
 * reads `model_name` and `model_info` and nothing else.
 */
export interface LiteLLMModelInfoEntry {
  model_name?: string
  model_info?: LiteLLMModelInfo
}

export interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfoEntry[]
}

/**
 * The `mode` values LiteLLM itself documents, from the `sample_spec` entry in
 * `model_prices_and_context_window.json`: chat, completion, embedding,
 * image_generation, audio_transcription, audio_speech, moderation, rerank,
 * search. `responses` is not in that list but is emitted by some deployments,
 * so it is accepted as a chat mode too.
 *
 * Only these three are usable in opencode's picker; everything else is a
 * non-chat endpoint.
 */
export const LITELLM_CHAT_MODES: ReadonlySet<string> = new Set(['chat', 'completion', 'responses'])

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'unknown'

/**
 * A single opencode cost tier. Values are USD per 1M tokens. `input` and
 * `output` are required by opencode's schema; cache fields are optional.
 */
export interface CostTier {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

/**
 * opencode config-level `cost` block (as it appears in
 * `provider.*.models.*.cost` in opencode.json), with optional tiered
 * pricing for contexts over 200k tokens.
 */
export interface CostBlock extends CostTier {
  context_over_200k?: CostTier
}

/**
 * Options accepted on a matched LiteLLM provider's `options` block. `baseURL`
 * is the only required one — pricing comes from the proxy it names.
 */
export interface LiteLLMOptions {
  baseURL?: string
  apiKey?: string
  customHeaders?: Record<string, string>
}

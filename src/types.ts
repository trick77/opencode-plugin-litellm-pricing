// Core types for the opencode-plugin-litellm-pricing plugin.
//
// Models the subset of LiteLLM's OpenAI-compatible /v1/models and
// /model_group/info payloads the plugin needs, plus the price-map entry shape
// the cost fields for opencode's per-model `cost` block are read from.

/**
 * A single model entry returned by LiteLLM's `/v1/models` endpoint.
 * LiteLLM follows the OpenAI-compatible schema; the capability/limit fields
 * below are LiteLLM-specific extensions that `/v1/models` does not carry —
 * `enrichModel` overlays them from `/model_group/info`.
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
   * NOT returned by `/v1/models`: its documented response shape is
   * `{id, object, created, owned_by}`. Present via `/model_group/info`.
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
 * is both the format of the price table the catalog reads and the shape of
 * the `model_info` block LiteLLM's own endpoints return. Cost values are USD
 * **per token**; opencode expects USD **per 1,000,000 tokens**, so the cost
 * mapper scales them by 1e6.
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
 * A single entry returned by LiteLLM's `/model_group/info` endpoint.
 *
 * Keyed by `model_group`, which is the same string `/v1/models` reports as a
 * model `id` — so unlike `/v1/model/info` no alias resolution is needed. This
 * is the plugin's source for `mode` (what kind of model it is) and for the
 * capability flags. The endpoint also returns per-token cost fields; they are
 * deliberately not declared here and never read — pricing comes from the
 * price-table catalog by policy, because LiteLLM's own numbers silently become
 * $0 when a deployment's `base_model` is misconfigured.
 *
 * `mode` may legitimately be `null` — LiteLLM emits that for models it has no
 * price-map entry for — which is why classification falls back to the id
 * heuristics per model rather than all-or-nothing.
 */
export interface LiteLLMModelGroupInfo {
  model_group: string
  providers?: string[]
  mode?: string | null
  max_input_tokens?: number | null
  max_output_tokens?: number | null
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
}

export interface LiteLLMModelGroupResponse {
  data?: LiteLLMModelGroupInfo[]
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

/** Options accepted on a matched LiteLLM provider's `options` block. */
export interface LiteLLMOptions {
  baseURL?: string
  apiKey?: string
  customHeaders?: Record<string, string>
}

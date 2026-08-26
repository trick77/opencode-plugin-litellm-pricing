// Build an opencode config-level model entry (the shape used in
// provider.*.models.* in opencode.json) from a discovered LiteLLM model,
// including the per-model `cost` block — the reason this plugin exists.

import type { CostBlock, CostTier, LiteLLMModel, LiteLLMModelInfo } from './types.ts'
import { categorizeModel, formatModelName } from './format-model-name.ts'

// LiteLLM reports cost as USD per token; opencode expects USD per 1,000,000
// tokens.
const TOKENS_PER_MILLION = 1_000_000

function perMillion(value: number | null | undefined): number | undefined {
  // Absent (null/undefined), non-finite, or negative → "no value". A
  // legitimate 0 (a free input/cache tier) is preserved, not dropped.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // Round to 6 decimals to strip floating-point noise from the ×1e6 scale
  // (e.g. 5e-8 * 1e6 = 0.05000000000000001 -> 0.05) so clean numbers land
  // in the injected config. 6 decimals = sub-cent-per-million precision.
  return Math.round(value * TOKENS_PER_MILLION * 1e6) / 1e6
}

/**
 * Build opencode's `cost` block from LiteLLM's resolved per-token costs.
 *
 * opencode's schema REQUIRES both `input` and `output`. If the proxy did
 * not surface both, we return `undefined` and omit `cost` entirely — a
 * blank price is preferable to a partial or misleading one. A cost of 0 is
 * a real value (free tier) and is kept.
 *
 * Tiered pricing is emitted only for LiteLLM's *_above_200k_tokens keys,
 * which match opencode's fixed `context_over_200k` bucket. LiteLLM's
 * *_above_272k_tokens tier (some Azure/OpenAI models) is deliberately NOT
 * mapped: forcing a 272k tier into a 200k bucket would overcharge the
 * 200k–272k band. Those models stay exact up to 272k on base rates.
 */
export function buildCost(info: LiteLLMModelInfo | undefined): CostBlock | undefined {
  if (!info) return undefined
  const tier = buildTier(
    info.input_cost_per_token,
    info.output_cost_per_token,
    info.cache_read_input_token_cost,
    info.cache_creation_input_token_cost,
  )
  if (!tier) return undefined

  const cost: CostBlock = tier
  const over200k = buildTier(
    info.input_cost_per_token_above_200k_tokens,
    info.output_cost_per_token_above_200k_tokens,
    info.cache_read_input_token_cost_above_200k_tokens,
    info.cache_creation_input_token_cost_above_200k_tokens,
  )
  if (over200k) cost.context_over_200k = over200k
  return cost
}

/** Build a single cost tier, or `undefined` if input/output aren't both set. */
function buildTier(
  inputPerToken: number | null | undefined,
  outputPerToken: number | null | undefined,
  cacheReadPerToken: number | null | undefined,
  cacheWritePerToken: number | null | undefined,
): CostTier | undefined {
  const input = perMillion(inputPerToken)
  const output = perMillion(outputPerToken)
  if (input == null || output == null) return undefined

  const tier: CostTier = { input, output }
  const cacheRead = perMillion(cacheReadPerToken)
  const cacheWrite = perMillion(cacheWritePerToken)
  if (cacheRead != null) tier.cache_read = cacheRead
  if (cacheWrite != null) tier.cache_write = cacheWrite
  return tier
}

/**
 * Overlay a /v1/model/info `model_info` block onto a /v1/models entry (the lean
 * entry wins; the info block fills gaps).
 *
 * On current LiteLLM /v1/models already carries `mode` and the token limits, so
 * most of this is a no-op; on an older proxy the info block is the only source
 * for all of it. The capability flags come from here either way.
 *
 * `null` is normalised to `undefined` so a missing value reads as missing
 * through the `??` chains.
 */
export function enrichModel(model: LiteLLMModel, info: LiteLLMModelInfo): LiteLLMModel {
  return {
    ...model,
    mode: model.mode ?? info.mode ?? undefined,
    max_tokens: model.max_tokens ?? info.max_tokens ?? undefined,
    max_input_tokens: model.max_input_tokens ?? info.max_input_tokens ?? undefined,
    max_output_tokens: model.max_output_tokens ?? info.max_output_tokens ?? undefined,
    supports_function_calling: model.supports_function_calling ?? info.supports_function_calling,
    supports_vision: model.supports_vision ?? info.supports_vision,
    supports_reasoning: model.supports_reasoning ?? info.supports_reasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.supports_pdf_input,
    supports_audio_input: model.supports_audio_input ?? info.supports_audio_input,
  }
}

/**
 * Build a config entry for a discovered model.
 *
 * Returns `null` for anything that isn't a chat model (embedding/image/audio/
 * rerank/moderation) so non-chat models don't clutter the picker.
 *
 * `model` should already carry whatever /v1/model/info returned (apply it with
 * `enrichModel` first) so `categorizeModel` can classify on the proxy's own
 * `mode` before falling back to the id heuristics.
 *
 * `info` is the same block again, and is read here only for cost. It may be
 * undefined — a proxy older than LiteLLM v1.96.0, or a key that cannot read
 * /v1/model/info — in which case the model is still injected, just unpriced.
 */
export function configModelFromProxy(
  model: LiteLLMModel,
  info: LiteLLMModelInfo | undefined,
): Record<string, unknown> | null {
  if (categorizeModel(model) !== 'chat') return null

  const entry: Record<string, unknown> = { name: formatModelName(model) }

  // LiteLLM semantics: max_input_tokens = context window; max_output_tokens
  // = max completion; max_tokens is the legacy alias of max_output_tokens
  // (NOT total context). Emit a limit only when the context window is known,
  // so we never report a bogus 0-token window.
  const context = model.max_input_tokens
  const output = model.max_output_tokens ?? model.max_tokens
  if (context != null && output != null) {
    entry.limit = { context, output }
  }

  if (model.supports_function_calling) entry.tool_call = true
  if (model.supports_reasoning) entry.reasoning = true
  if (model.supports_vision) entry.attachment = true

  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (model.supports_vision) input.push('image')
  if (model.supports_pdf_input) input.push('pdf')
  if (model.supports_audio_input) input.push('audio')
  if (input.length > 1) entry.modalities = { input, output: ['text'] }

  const cost = buildCost(info)
  if (cost) entry.cost = cost
  return entry
}

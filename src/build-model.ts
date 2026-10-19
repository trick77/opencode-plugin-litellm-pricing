// Build a `ModelSpec` — what the provider transform writes onto an opencode V2
// `Model.Info` — from a discovered LiteLLM model, including the per-model
// `cost` tiers, the reason this plugin exists.
//
// Kept pure and free of opencode types so it can be unit-tested without a
// host: the transform in plugin.ts is the only place a spec meets a draft.

import type { CostTier, LiteLLMModel, LiteLLMModelInfo, ModelSpec } from './types.ts'
import { categorizeModel, formatModelName } from './format-model-name.ts'

// LiteLLM reports cost as USD per token; opencode expects USD per 1,000,000
// tokens.
const TOKENS_PER_MILLION = 1_000_000

/**
 * opencode V2's context-tier boundary for LiteLLM's `*_above_200k_tokens`
 * fields. V2 tiers carry an explicit size, so this is the one place the 200k
 * boundary is stated.
 */
const OVER_200K_TIER = { type: 'context', size: 200_000 } as const

function perMillion(value: number | null | undefined): number | undefined {
  // Absent (null/undefined), non-finite, or negative → "no value". A
  // legitimate 0 (a free input/cache tier) is preserved, not dropped.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // Round to 6 decimals to strip floating-point noise from the ×1e6 scale
  // (e.g. 5e-8 * 1e6 = 0.05000000000000001 -> 0.05) so clean numbers land
  // in opencode. 6 decimals = sub-cent-per-million precision.
  return Math.round(value * TOKENS_PER_MILLION * 1e6) / 1e6
}

/**
 * Build opencode V2's `cost` array from LiteLLM's resolved per-token costs.
 *
 * A V2 tier REQUIRES `input` and `output`. If the proxy did not surface both,
 * the result is `[]` — unpriced — rather than a partial or misleading price. A
 * cost of 0 is a real value (free tier) and is kept.
 *
 * Tiered pricing is emitted only for LiteLLM's *_above_200k_tokens keys, as a
 * second tier sized 200k. LiteLLM's *_above_272k_tokens tier (some
 * Azure/OpenAI models) is deliberately NOT mapped: it would have to share the
 * 200k boundary opencode's migrated configs use, which overcharges the
 * 200k–272k band. Those models stay exact up to 272k on base rates.
 *
 * A fresh array and fresh tier objects every call: one info block can serve
 * several model ids, and a shared tier would alias across opencode's models.
 */
export function buildCost(info: LiteLLMModelInfo | undefined): CostTier[] {
  if (!info) return []
  const base = buildTier(
    info.input_cost_per_token,
    info.output_cost_per_token,
    info.cache_read_input_token_cost,
    info.cache_creation_input_token_cost,
  )
  if (!base) return []

  const tiers: CostTier[] = [base]
  const over200k = buildTier(
    info.input_cost_per_token_above_200k_tokens,
    info.output_cost_per_token_above_200k_tokens,
    info.cache_read_input_token_cost_above_200k_tokens,
    info.cache_creation_input_token_cost_above_200k_tokens,
  )
  if (over200k) tiers.push({ tier: { ...OVER_200K_TIER }, ...over200k })
  return tiers
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

  // V2 requires both cache prices. Unknown → 0, matching what opencode's own
  // V1→V2 config migration writes for an absent `cache_read`/`cache_write`.
  return {
    input,
    output,
    cache: {
      read: perMillion(cacheReadPerToken) ?? 0,
      write: perMillion(cacheWritePerToken) ?? 0,
    },
  }
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
 * Build the spec for a discovered model.
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
export function modelSpecFromProxy(
  model: LiteLLMModel,
  info: LiteLLMModelInfo | undefined,
): ModelSpec | null {
  if (categorizeModel(model) !== 'chat') return null

  const spec: ModelSpec = {
    name: formatModelName(model),
    input: ['text'],
    reasoning: model.supports_reasoning === true,
    cost: buildCost(info),
  }

  // LiteLLM semantics: max_input_tokens = context window; max_output_tokens
  // = max completion; max_tokens is the legacy alias of max_output_tokens
  // (NOT total context). Each side is set only when known: an unknown side
  // keeps opencode's `Model.Info.default` value instead of a bogus 0.
  const context = model.max_input_tokens
  const output = model.max_output_tokens ?? model.max_tokens
  if (context != null || output != null) {
    spec.limit = {}
    if (context != null) spec.limit.context = context
    if (output != null) spec.limit.output = output
  }

  // Tool calling is stated only when the proxy said so either way. V2's
  // default is `tools: true`; an older proxy that cannot answer must not
  // switch tools off for every model it serves.
  if (typeof model.supports_function_calling === 'boolean') {
    spec.tools = model.supports_function_calling
  }

  // Input modalities are always written, starting from text. V2's default
  // claims `image` too, which would offer image attachments to a model the
  // proxy never said could see.
  if (model.supports_vision) spec.input.push('image')
  if (model.supports_pdf_input) spec.input.push('pdf')
  if (model.supports_audio_input) spec.input.push('audio')

  return spec
}

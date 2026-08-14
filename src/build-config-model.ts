// Build an opencode config-level model entry (the shape used in
// provider.*.models.* in opencode.json) from a discovered LiteLLM model,
// including the per-model `cost` block — the reason this plugin exists.

import type {
  CostBlock,
  CostTier,
  LiteLLMModel,
  LiteLLMModelGroupInfo,
  LiteLLMModelInfo,
} from './types.ts'
import type { CatalogFields } from './catalog.ts'
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
 * Adapt a /model_group/info entry to the LiteLLMModelInfo shape so it can
 * go through the same `enrichModel` overlay.
 *
 * `max_tokens` is deliberately NOT mapped: the group response exposes
 * `max_input_tokens`/`max_output_tokens`, and the `max_tokens` some pages show
 * is ambiguous there. Leaving it undefined keeps the
 * `max_output_tokens ?? max_tokens` fallback honest. Cost is not mapped
 * either — the group endpoint carries none, and pricing comes from the price
 * table.
 *
 * `null` is normalised to `undefined` so the `??` chains in `enrichModel`
 * treat a missing value as missing.
 */
export function groupInfoToModelInfo(group: LiteLLMModelGroupInfo): LiteLLMModelInfo {
  return {
    mode: group.mode ?? undefined,
    max_input_tokens: group.max_input_tokens ?? undefined,
    max_output_tokens: group.max_output_tokens ?? undefined,
    supports_function_calling: group.supports_function_calling,
    supports_vision: group.supports_vision,
    supports_reasoning: group.supports_reasoning,
    supports_pdf_input: group.supports_pdf_input,
    supports_audio_input: group.supports_audio_input,
  }
}

/**
 * Overlay /v1/model/info metadata onto a /v1/models entry (the lean entry
 * wins; the info block fills gaps — notably `mode`, token limits, and
 * capability flags, which /v1/models omits for database-defined models).
 */
export function enrichModel(model: LiteLLMModel, info: LiteLLMModelInfo): LiteLLMModel {
  return {
    ...model,
    mode: model.mode ?? info.mode,
    max_tokens: model.max_tokens ?? info.max_tokens,
    max_input_tokens: model.max_input_tokens ?? info.max_input_tokens,
    max_output_tokens: model.max_output_tokens ?? info.max_output_tokens,
    supports_function_calling: model.supports_function_calling ?? info.supports_function_calling,
    supports_vision: model.supports_vision ?? info.supports_vision,
    supports_reasoning: model.supports_reasoning ?? info.supports_reasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.supports_pdf_input,
    supports_audio_input: model.supports_audio_input ?? info.supports_audio_input,
  }
}

/**
 * Convert a discovered LiteLLM model into an opencode config model entry.
 * Merges `info` onto `model` first (single code path), then returns `null`
 * for anything that isn't a chat model (embedding/image/audio/rerank/
 * moderation) so non-chat models don't clutter the picker.
 */
export function toConfigModel(
  model: LiteLLMModel,
  info: LiteLLMModelInfo | undefined,
): Record<string, unknown> | null {
  const m = info ? enrichModel(model, info) : model

  if (categorizeModel(m) !== 'chat') return null

  const entry: Record<string, unknown> = { name: formatModelName(m) }

  // LiteLLM semantics: max_input_tokens = context window; max_output_tokens
  // = max completion; max_tokens is the legacy alias of max_output_tokens
  // (NOT total context). Emit a limit only when the context window is known,
  // so we never report a bogus 0-token window.
  const context = m.max_input_tokens
  const output = m.max_output_tokens ?? m.max_tokens
  if (context != null && output != null) {
    entry.limit = { context, output }
  }

  const cost = buildCost(info)
  if (cost) entry.cost = cost

  if (m.supports_function_calling) entry.tool_call = true
  if (m.supports_reasoning) entry.reasoning = true
  if (m.supports_vision) entry.attachment = true

  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (m.supports_vision) input.push('image')
  if (m.supports_pdf_input) input.push('pdf')
  if (m.supports_audio_input) input.push('audio')
  if (input.length > 1) entry.modalities = { input, output: ['text'] }

  return entry
}

/**
 * The live path: build a config entry for a discovered model.
 *
 * `model` should already carry whatever `/model_group/info` returned, so
 * `categorizeModel` can classify on LiteLLM's own `mode` and fall back to the
 * id heuristic only when there isn't one.
 *
 * LiteLLM's limits and capability flags win where present; `fields` (matched
 * from the price-table catalog) supply cost and fill the remaining gaps, and
 * may be null when nothing matched — the model is still injected, just barer.
 */
export function configModelFromCatalog(
  model: LiteLLMModel,
  fields: CatalogFields | null,
): Record<string, unknown> | null {
  // Identical to `toConfigModel` with no info block (no cost is ever sourced
  // from the proxy), so it goes through that one implementation rather than a
  // second copy of the limit/flag/modality logic that could drift.
  const entry = toConfigModel(model, undefined)
  if (!entry) return null
  if (fields) applyCatalogFields(entry, fields)
  return entry
}

type Modalities = { input: string[]; output: string[] }

/** Copy a cost block, nested tier included — a shallow spread would alias it. */
function cloneCost(cost: CostBlock): CostBlock {
  const { context_over_200k, ...tier } = cost
  return context_over_200k ? { ...tier, context_over_200k: { ...context_over_200k } } : { ...tier }
}

/**
 * Merge catalog fields into an entry, without overwriting existing keys.
 *
 * Copies rather than aliases: `catalog.resolve()` hands back the SAME
 * `CatalogFields` object for every model that matched one table entry, so
 * assigning it directly would put one shared cost/limit object into several
 * places in opencode's config tree.
 */
export function applyCatalogFields(entry: Record<string, unknown>, fields: CatalogFields): void {
  if (fields.cost && !entry.cost) entry.cost = cloneCost(fields.cost)
  if (fields.limit && !entry.limit) entry.limit = { ...fields.limit }
  if (fields.reasoning && entry.reasoning == null) entry.reasoning = true
  if (fields.tool_call && entry.tool_call == null) entry.tool_call = true
  if (fields.attachment && entry.attachment == null) entry.attachment = true
  // Union, never replace: LiteLLM's capability flags are sparse (a group that
  // reports only `supports_vision` would otherwise shrink a catalog entry that
  // knew about pdf/audio down to text+image).
  if (fields.modalities) mergeModalities(entry, fields.modalities)
}

/** Merge catalog modalities into an entry's, keeping every input already listed. */
function mergeModalities(entry: Record<string, unknown>, fromCatalog: Modalities): void {
  const existing = entry.modalities as Modalities | undefined
  if (!existing) {
    // Copied, not aliased — see applyCatalogFields.
    entry.modalities = { input: [...fromCatalog.input], output: [...fromCatalog.output] }
    return
  }
  const input = [...existing.input]
  for (const modality of fromCatalog.input) {
    if (!input.includes(modality)) input.push(modality)
  }
  entry.modalities = { input, output: existing.output }
}

// LiteLLM proxy HTTP client: model discovery from /v1/models, and per-model
// metadata (including cost) from /v1/model/info. The model-info reader
// carries cost fields through and falls back to litellm_params for
// cost/capability keys set there.
//
// Every call targets the caller-supplied base URL and nothing else. There is
// deliberately no default URL and no port auto-detection: an unconfigured
// provider is an error to report, not a reason to go probing the local
// machine.

import type {
  LiteLLMModel,
  LiteLLMModelGroupInfo,
  LiteLLMModelGroupResponse,
  LiteLLMModelInfo,
  LiteLLMModelInfoEntry,
  LiteLLMModelInfoResponse,
  LiteLLMModelsResponse,
} from './types.ts'

const MODELS_ENDPOINT = '/v1/models'
const MODEL_INFO_ENDPOINT = '/v1/model/info'
// NOTE: no `/v1` prefix. Unlike `/model/info` (which LiteLLM also aliases as
// `/v1/model/info`), the model-group endpoint is registered only at the
// unprefixed path — every example in LiteLLM's docs uses `/model_group/info`.
// `/v1/model_group/info` 404s, which this plugin would swallow as "endpoint
// refused" and silently degrade to the id heuristics forever.
const MODEL_GROUP_INFO_ENDPOINT = '/model_group/info'
const FETCH_TIMEOUT_MS = 15000
/**
 * Tight budget for the capability lookup. It is an optional enrichment on top
 * of /v1/models, so a slow or hanging proxy costs a few seconds at startup,
 * never the full FETCH_TIMEOUT_MS.
 */
const METADATA_TIMEOUT_MS = 3000

/** Numeric keys we also accept off `litellm_params` when absent in model_info. */
const NUMERIC_INFO_KEYS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'input_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'cache_read_input_token_cost_above_200k_tokens',
  'cache_creation_input_token_cost_above_200k_tokens',
  'max_tokens',
  'max_input_tokens',
  'max_output_tokens',
] as const

/** Boolean capability keys that some deployments set on `litellm_params`. */
const CAPABILITY_FLAGS = [
  'supports_vision',
  'supports_function_calling',
  'supports_reasoning',
  'supports_pdf_input',
  'supports_audio_input',
] as const

/**
 * Normalise a base URL so the rest of the plugin can rely on a predictable
 * shape (no trailing slash, no `/v1` suffix).
 */
export function normalizeBaseURL(baseURL: string): string {
  let normalized = baseURL.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

/** Build a full URL for a given API endpoint. */
export function buildAPIURL(baseURL: string, endpoint: string = MODELS_ENDPOINT): string {
  return `${normalizeBaseURL(baseURL)}${endpoint}`
}

/**
 * Resolve the API key: an explicit value wins, else the LiteLLM env vars.
 * Single source of precedence, used by both the header builder and the
 * plugin's discovery call.
 */
export function resolveApiKey(explicit?: string): string | undefined {
  return explicit ?? process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
}

function buildHeaders(
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = resolveApiKey(apiKey)
  if (key) headers['Authorization'] = `Bearer ${key}`
  if (customHeaders) Object.assign(headers, customHeaders)
  return headers
}

/** Discover all models exposed by a LiteLLM proxy via /v1/models. */
export async function discoverLiteLLMModels(
  baseURL: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<LiteLLMModel[]> {
  const response = await fetch(buildAPIURL(baseURL), {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as LiteLLMModelsResponse
  return data.data ?? []
}

/**
 * Fetch per-model-group capabilities from /model_group/info, keyed by
 * `model_group`.
 *
 * This is where `mode` comes from — the field that says whether a model is a
 * chat model, an embedding model, a reranker, and so on. /v1/models does not
 * carry it (its response is just id/object/created/owned_by), so without this
 * the non-chat filter can only guess from the model id.
 *
 * Preferred over /v1/model/info because `model_group` IS the `model_name` that
 * /v1/models reports, so no alias resolution is needed. The response DOES
 * carry per-token cost fields; they are deliberately not read. Pricing comes
 * from the price-table catalog alone, by policy: LiteLLM's numbers are only
 * right when the deployment sets `model_info.base_model`, and getting that
 * wrong silently bills $0.
 *
 * Callers MUST treat failure as non-fatal. Whether this endpoint needs an
 * elevated key is not settled — LiteLLM's own docs describe it both as a
 * discovery endpoint alongside /v1/models and as needing management access —
 * so discovery has to keep working without it.
 */
export async function discoverLiteLLMModelGroups(
  baseURL: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<Map<string, LiteLLMModelGroupInfo>> {
  const response = await fetch(buildAPIURL(baseURL, MODEL_GROUP_INFO_ENDPOINT), {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LiteLLMModelGroupResponse
  const byGroup = new Map<string, LiteLLMModelGroupInfo>()
  for (const group of data.data ?? []) {
    // First entry wins, mirroring the public-name-wins rule in the reader below.
    if (group?.model_group && !byGroup.has(group.model_group)) {
      byGroup.set(group.model_group, group)
    }
  }
  return byGroup
}

/**
 * Fetch per-model metadata (mode, token limits, capability flags, and cost)
 * from /v1/model/info, keyed by every alias LiteLLM may use for a model so
 * the `/v1/models` id reliably matches.
 *
 * Unused by the live path: `discoverLiteLLMModelGroups` covers the same need
 * with simpler keying and no cost fields. Kept as the only reader for the
 * litellm_params cost/capability fallback.
 */
export async function discoverLiteLLMModelInfo(
  baseURL: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<Map<string, LiteLLMModelInfo>> {
  const response = await fetch(buildAPIURL(baseURL, MODEL_INFO_ENDPOINT), {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LiteLLMModelInfoResponse
  const infoByName = new Map<string, LiteLLMModelInfo>()

  // Build each entry's info once, filling cost/capability gaps from
  // litellm_params (some deployments declare them there, not in model_info).
  const built: Array<{ entry: LiteLLMModelInfoEntry; info: LiteLLMModelInfo }> = []
  for (const entry of data.data ?? []) {
    if (!entry.model_info) continue
    const info: LiteLLMModelInfo = { ...entry.model_info } // spread preserves cost verbatim
    const params = entry.litellm_params ?? {}
    for (const flag of CAPABILITY_FLAGS) {
      const v = params[flag]
      if (info[flag] == null && typeof v === 'boolean') info[flag] = v
    }
    for (const numKey of NUMERIC_INFO_KEYS) {
      const v = params[numKey]
      if (info[numKey] == null && typeof v === 'number') info[numKey] = v
    }
    built.push({ entry, info })
  }

  // Pass 1: register the public model_name (what /v1/models reports) so a
  // public name always wins. Pass 2: register internal aliases
  // (model_info.key, litellm_params.model) only if unclaimed — an earlier
  // entry's alias must never shadow a later model's own public name.
  for (const { entry, info } of built) {
    if (entry.model_name && !infoByName.has(entry.model_name)) {
      infoByName.set(entry.model_name, info)
    }
  }
  for (const { entry, info } of built) {
    const aliases = [
      entry.model_info?.key,
      typeof entry.litellm_params?.model === 'string' ? entry.litellm_params.model : undefined,
    ]
    for (const alias of aliases) {
      if (alias && !infoByName.has(alias)) infoByName.set(alias, info)
    }
  }
  return infoByName
}

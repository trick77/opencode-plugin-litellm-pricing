// LiteLLM proxy HTTP client: model discovery from /v1/models, and per-model
// pricing, limits and capabilities from /v1/model/info.
//
// Every call targets the caller-supplied base URL and nothing else. There is
// deliberately no default URL and no port auto-detection: an unconfigured
// provider is an error to report, not a reason to go probing the local
// machine.

import type {
  LiteLLMModel,
  LiteLLMModelInfo,
  LiteLLMModelInfoResponse,
  LiteLLMModelsResponse,
} from './types.ts'

const MODELS_ENDPOINT = '/v1/models'
/**
 * The pricing endpoint. `/v1/model/info` and `/model/info` are the same
 * handler; the `/v1` spelling is used because it is the documented one.
 *
 * NEVER `/v2/model/info`. LiteLLM v1.96.0 opened `model_info_routes` —
 * `/model/info` and `/v1/model/info` — to `llm_api_routes`, which is what a
 * `key_type: "llm_api"` key carries. `/v2/model/info` stayed in `info_routes`
 * (it is the paginated Admin UI listing) and still needs an elevated key, so
 * calling it would 403 exactly the keys this endpoint exists to serve.
 */
const MODEL_INFO_ENDPOINT = '/v1/model/info'
const FETCH_TIMEOUT_MS = 15000

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
 * Does a `model_info` block carry a usable input price?
 *
 * The tie-breaker between two deployments of one model group: LiteLLM resolves
 * cost per deployment, so a group whose first deployment has no `base_model`
 * mapping and whose second one does must resolve to the second.
 *
 * Both fields are checked because both are what `buildCost` needs: a row
 * carrying only `input_cost_per_token` (some audio/rerank price-map entries
 * price output per second, not per token) emits no `cost` at all, so treating
 * it as priced would let it beat a sibling deployment that does resolve both.
 */
function hasPrice(info: LiteLLMModelInfo | undefined): boolean {
  return (
    typeof info?.input_cost_per_token === 'number' &&
    typeof info?.output_cost_per_token === 'number'
  )
}

/**
 * Fetch per-model pricing, limits and capabilities from /v1/model/info, keyed
 * by `model_name` — the public model-group name, which is exactly the id
 * /v1/models reports, so no alias resolution is needed.
 *
 * This is the plugin's pricing source, and also where `mode` comes from on a
 * proxy whose /v1/models is too old to emit it.
 *
 * Callers MUST treat failure as non-fatal: the endpoint is only readable by a
 * plain LLM API key from LiteLLM v1.96.0 on, and a key can still be scoped to
 * exclude it. Models are worth injecting unpriced.
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
  const byName = new Map<string, LiteLLMModelInfo>()
  for (const entry of data.data ?? []) {
    const name = entry?.model_name
    if (typeof name !== 'string' || !name) continue
    const info = entry.model_info
    if (!info || typeof info !== 'object') continue
    // First priced row wins; an unpriced row only fills an empty slot, so a
    // later priced deployment of the same group still upgrades it.
    const existing = byName.get(name)
    if (existing && (hasPrice(existing) || !hasPrice(info))) continue
    byName.set(name, info)
  }
  return byName
}

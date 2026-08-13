// The pricing source.
//
// Cost, context limits and capability flags come from a price table in
// LiteLLM's `model_prices_and_context_window.json` format, matched to the
// LiteLLM model by name. The URL is configurable (`options.pricingURL`), which
// is the point: LiteLLM's own published table covers the public providers,
// while a proxy operator can serve an enriched copy of the same file that also
// carries their gateway's own model names — those then price by exact key
// instead of by lucky substring.
//
// The table comes from a week-long on-disk cache. Once that cache exists no
// start ever waits on the network again: a stale copy is served immediately and
// refreshed behind the user's back. Only the very first start after install has
// nothing to read, and that one waits for the fetch — the `config` hook runs
// exactly once, before anything is displayed, so a model injected unpriced
// there stays unpriced for the whole session. See load() for the ordering.
//
// LiteLLM's own per-deployment prices (from the proxy's /v1/model/info) are not
// used because reading that endpoint requires an admin key — a normal virtual
// key gets nothing back, so it is not a source the plugin can rely on.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CostBlock, LiteLLMModelInfo } from './types.ts'
import { buildCost } from './build-config-model.ts'

/**
 * LiteLLM's published price table — the default source.
 *
 * Anything serving the same format works: point `options.pricingURL` at an
 * enriched copy and its extra entries price by exact model name.
 */
export const DEFAULT_PRICE_TABLE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// Providers whose entries may be matched by SUBSTRING, in precedence order.
// These LiteLLM deployments are Azure/OpenAI; both carry the full model line
// and price it identically, so Azure is preferred with OpenAI as an equivalent
// fallback. Restricting the substring pass to these two avoids false matches
// against third-party aggregators that use slash-laden ids.
//
// Exact-key matching is NOT restricted this way — it runs over every entry in
// the table, because an exact key cannot match the wrong model, and a filter
// there would throw away precisely the enriched entries a custom table exists
// to provide.
const PREFERRED_PROVIDERS = ['azure', 'openai']

/** The documentation stub LiteLLM ships as the first key. Never a model. */
const SAMPLE_SPEC_KEY = 'sample_spec'

/** The opencode-config fields we can source from a catalog model. */
export interface CatalogFields {
  cost?: CostBlock
  limit?: { context: number; output: number }
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input: string[]; output: string[] }
}

export interface Catalog {
  /** Resolve a LiteLLM model name to catalog fields, or null if unmatched. */
  resolve(litellmModelName: string): CatalogFields | null
  /** How many table entries the catalog was built from. */
  readonly candidateCount: number
  /** Which of PREFERRED_PROVIDERS contributed substring candidates. */
  readonly matchedProviders: readonly string[]
}

/**
 * Why pricing did or did not happen. `getCatalog` returns `null` for both "the
 * load failed" and "the response had nothing usable", and `resolve` returns
 * `null` for both "no catalog" and "no name match" — so without this, a run
 * that prices nothing is indistinguishable from a run with nothing to price.
 */
export interface CatalogStatus {
  /** 'loading' until the load settles — never a verdict, just "not yet". */
  state: 'loading' | 'ok' | 'unavailable'
  /** Which endpoint answered. */
  source?: string
  /** Populated when state is 'unavailable'. */
  reason?: string
  candidateCount?: number
  matchedProviders?: readonly string[]
  elapsedMs?: number
}

interface Candidate {
  id: string // lowercased entry key, provider prefix stripped, e.g. "gpt-5.4-mini"
  fields: CatalogFields
}

/**
 * Bound on the price-table fetch: the background refresh, and the first-start
 * fetch in load() that has no cache to fall back on. Short on purpose — that
 * first start is the only one anybody waits through.
 */
const CATALOG_TIMEOUT_MS = 3_000

/** One load per distinct price-table URL, memoized for the process. */
interface Load {
  promise: Promise<Catalog | null>
  status: CatalogStatus
}
const loads = new Map<string, Load>()

/** What happened on the load for `url`. Safe to call before it runs. */
export function getCatalogStatus(url: string): CatalogStatus {
  return loads.get(url)?.status ?? { state: 'loading' }
}

/**
 * Load the price table for `url` once per process (memoized).
 *
 * Safe to await from inside the `config` hook, which is where the configured
 * URL first becomes readable: every branch but the very first start answers
 * from the on-disk cache, and demotes the network to a background
 * refresh. See load().
 */
export function getCatalog(url: string): Promise<Catalog | null> {
  const existing = loads.get(url)
  if (existing) return existing.promise

  const entry: Load = { promise: Promise.resolve(null), status: { state: 'loading' } }
  loads.set(url, entry)
  entry.promise = load(url).then(
    (result) => {
      entry.status = result.status
      return result.catalog
    },
    (err: unknown) => {
      // load() is written not to reject, but the `config` hook awaits this
      // promise and must never throw out of it. Record the failure as a real
      // verdict too, or the caller's report reads "unavailable (undefined)".
      entry.status = {
        state: 'unavailable',
        source: url,
        reason: err instanceof Error ? err.message : String(err),
      }
      return null
    },
  )
  return entry.promise
}

/** Clear the memoized catalogs — used by tests. */
export function resetCatalogCache(): void {
  pendingRefreshes.length = 0
  loads.clear()
}

/** Where the last good copy is kept, so a cold start still prices offline. */
function cachePath(url: string): string {
  const base = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), '.cache')
  // Keyed by URL: two providers pointed at different tables must never be
  // served each other's prices, and switching a URL must not read the old one.
  const key = createHash('sha256').update(url).digest('hex').slice(0, 12)
  return join(base, 'opencode-plugin-litellm-pricing', `price-table-${key}.json`)
}

/**
 * Serve the cache without re-fetching for this long. A week: these are public
 * list prices, which move on the scale of provider announcements, and a refresh
 * happens in the background anyway so nobody waits for one.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Bump whenever the trimmed shape changes — including any change to
 * KEEP_FIELDS. The cache stores a subset, so a stale layout would otherwise be
 * served forever as if complete. On a mismatch the cache is discarded and
 * refetched.
 */
const CACHE_SCHEMA = 2

/**
 * The fields toCatalogFields and buildCost read, and nothing else. LiteLLM
 * publishes ~1.7 MB; restricted to these keys it is ~700 KB, which is what it
 * costs to re-read on every single start.
 *
 * Bump CACHE_SCHEMA when this list changes.
 */
const KEEP_FIELDS = [
  'litellm_provider',
  'max_input_tokens',
  'max_output_tokens',
  'max_tokens',
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'input_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'cache_read_input_token_cost_above_200k_tokens',
  'cache_creation_input_token_cost_above_200k_tokens',
  'supports_function_calling',
  'supports_reasoning',
  'supports_vision',
  'supports_pdf_input',
  'supports_audio_input',
]

/**
 * A price table, as parsed: model name → entry.
 *
 * Note what this does NOT do: filter by provider. The substring matcher only
 * looks at PREFERRED_PROVIDERS, but the exact-key matcher looks at everything,
 * and a custom table's enriched entries carry whatever `litellm_provider` their
 * operator gave them. Dropping non-preferred providers here would strip exactly
 * those entries out of the cache, and the feature would fail silently for the
 * case it exists for.
 */
function toTable(raw: unknown): Record<string, Record<string, unknown>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === SAMPLE_SPEC_KEY) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>
    }
  }
  return out
}

/** Trim a table to the fields we read, for storage. */
function trim(table: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(table)) {
    const kept: Record<string, unknown> = {}
    for (const field of KEEP_FIELDS) if (field in entry) kept[field] = entry[field]
    if (Object.keys(kept).length > 0) out[key] = kept
  }
  return out
}

/** Read the cached table for `url`. */
async function readCache(url: string): Promise<{
  table: Record<string, Record<string, unknown>>
  ageMs: number
} | null> {
  try {
    const path = cachePath(url)
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const envelope = JSON.parse(text) as { v?: unknown; url?: unknown; table?: unknown }
    if (envelope?.v !== CACHE_SCHEMA) return null
    // The filename is a hash, so a mismatch here means a collision or a
    // hand-copied file — either way it is not this URL's table.
    if (envelope.url !== url) return null
    const table = toTable(envelope.table)
    if (!table) return null
    return { table, ageMs: Date.now() - info.mtimeMs }
  } catch {
    return null
  }
}

async function writeCache(
  url: string,
  table: Record<string, Record<string, unknown>>,
): Promise<void> {
  const text = JSON.stringify({ v: CACHE_SCHEMA, url, table: trim(table) })
  const path = cachePath(url)
  // Write-then-rename, pid-scoped: two opencode processes starting at once
  // would otherwise interleave into a truncated file that never parses again
  // until the next successful fetch. rename() is atomic within a filesystem.
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  } catch {
    // A cache we cannot write is not a reason to fail the load.
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/** Build a catalog from a table, or null if there is nothing in it. */
function catalogFrom(table: Record<string, Record<string, unknown>>): Catalog | null {
  const catalog = buildFromTable(table)
  return catalog.candidateCount > 0 ? catalog : null
}

function ok(
  catalog: Catalog,
  source: string,
  t0: number,
): { catalog: Catalog; status: CatalogStatus } {
  return {
    catalog,
    status: {
      state: 'ok',
      source,
      elapsedMs: Date.now() - t0,
      candidateCount: catalog.candidateCount,
      matchedProviders: catalog.matchedProviders,
    },
  }
}

/** Fetch the live table and cache it. Throws; callers decide whether to care. */
async function fetchTable(url: string): Promise<Record<string, Record<string, unknown>>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const table = toTable(JSON.parse(await res.text()))
  if (!table) throw new Error('unexpected response shape')
  await writeCache(url, table)
  return table
}

/** The in-flight background refreshes — see settleRefreshForTests. */
const pendingRefreshes: Array<Promise<unknown>> = []

/**
 * Refresh for the NEXT launch, without anybody waiting for it.
 *
 * Safe to leave running: opencode does not wait on the event loop before
 * exiting — measured, a short CLI invocation exited 216 ms in with a
 * deliberately black-holed 3 s fetch still pending. So this either finishes in
 * a long-lived session and updates the cache, or the process ends first and the
 * next launch tries again. Neither delays anything.
 *
 * It must swallow its own failure: nothing observes this promise, and an
 * unhandled rejection would take the process down.
 */
function refreshInBackground(url: string): void {
  pendingRefreshes.push(fetchTable(url).catch(() => {}))
}

/**
 * Await every background refresh the loads started — used by tests.
 *
 * The refresh resolves `cachePath()` when it *writes*, not when it starts, and
 * the suite swaps `XDG_CACHE_HOME` per scenario. A refresh still in flight when
 * the next scenario begins therefore writes a valid cache into the NEXT test's
 * directory, which silently turns a no-table assertion into a cache hit.
 * Settling it at the end of each scenario is what keeps the branches isolated.
 */
export async function settleRefreshForTests(): Promise<void> {
  // Every refresh, not just the last one: two providers on two price-table
  // URLs each start one, and a straggler is exactly what writes into the next
  // scenario's cache directory.
  while (pendingRefreshes.length > 0) await Promise.all(pendingRefreshes.splice(0))
}

/**
 * Load the price table.
 *
 * Fetched over plain HTTPS rather than through opencode's client. That is not a
 * preference. opencode's server cannot answer a request while a plugin is
 * blocked waiting on it, so awaiting its provider list during plugin load
 * deadlocks — measured at 60 s for both `provider.list` and `config.providers`,
 * while the identical call left unawaited returned in 351 ms, right after the
 * `config` hook had already run. And that hook is invoked exactly once, under
 * `serve` and the CLI alike, so there is no later pass to price into.
 *
 * A published price table is also the more correct source: it carries every
 * provider, whereas `config.providers` carries only the ones the reader has
 * configured. A machine with no Azure credentials has no `azure` entry at all,
 * and the `openai` entry it does have reports every cost as 0 — pricing from
 * that would report $0 by accident of the reader's config, the exact failure
 * this plugin exists to prevent.
 */
async function load(url: string): Promise<{ catalog: Catalog | null; status: CatalogStatus }> {
  const t0 = Date.now()

  // Order matters, and the rule is: NEVER await the network to answer this.
  // The `config` hook runs once, so this call sits directly in front of
  // startup; a fetch here is a stall the user watches. Every branch below
  // answers from something already on disk or in the package, and demotes the
  // fetch to a background top-up for next time.
  const cached = await readCache(url)

  const fromCache = cached ? catalogFrom(cached.table) : null

  // 1. A fresh cache is authoritative — no network at all.
  if (cached && fromCache && cached.ageMs < CACHE_TTL_MS) return ok(fromCache, 'cache', t0)

  // 2. A stale cache is still the right answer NOW. Week-old list prices beat
  //    making someone wait, so serve them and refresh behind their back.
  if (fromCache) {
    refreshInBackground(url)
    return ok(fromCache, 'stale cache (refreshing)', t0)
  }

  // 3. No cache at all — a fresh install, or one that was cleared. This is the
  //    one branch that waits, because there is nothing else that could price
  //    this run: the `config` hook is invoked exactly once, before anything is
  //    displayed, so a model injected unpriced here stays unpriced for the
  //    whole session. Bounded by CATALOG_TIMEOUT_MS, and it happens once —
  //    every later start answers from branch 1 without touching the network.
  try {
    const table = await fetchTable(url)
    const catalog = catalogFrom(table)
    if (!catalog) throw new Error('no priceable entries')
    return ok(catalog, url, t0)
  } catch (err) {
    return {
      catalog: null,
      status: {
        state: 'unavailable',
        source: url,
        reason: `${err instanceof Error ? err.message : String(err)} after ${Date.now() - t0}ms`,
      },
    }
  }
}

/**
 * Build a name resolver from a LiteLLM-format price table. Pure and exported
 * for testing.
 *
 * Two lookups, in this order:
 *
 *  1. Exact key, over EVERY entry. `ai-gateway/gpt-5.4` in an enriched table
 *     resolves the model of that exact name — no provider filter, because an
 *     exact key cannot match the wrong model.
 *  2. Bounded substring, over PREFERRED_PROVIDERS only, with the provider
 *     prefix stripped so `azure/gpt-5.4` can match `ai-gateway-gpt-5.4`.
 */
export function buildFromTable(table: Record<string, unknown>): Catalog {
  const exact = new Map<string, CatalogFields>()
  const byProvider = new Map<string, Array<[string, Record<string, unknown>]>>()

  for (const [key, raw] of Object.entries(table)) {
    if (key === SAMPLE_SPEC_KEY) continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    exact.set(key.toLowerCase(), toCatalogFields(entry))
    const provider = typeof entry.litellm_provider === 'string' ? entry.litellm_provider : ''
    const bucket = byProvider.get(provider)
    if (bucket) bucket.push([key, entry])
    else byProvider.set(provider, [[key, entry]])
  }

  // Candidates in provider-precedence order, then sorted longest id first so
  // the first substring match is the most specific (…-mini beats base) and,
  // on a length tie, comes from the preferred provider (stable sort).
  const candidates: Candidate[] = []
  const matched: string[] = []
  for (const provider of PREFERRED_PROVIDERS) {
    const entries = byProvider.get(provider)
    if (!entries?.length) continue
    matched.push(provider)
    for (const [key, entry] of entries) {
      candidates.push({
        id: stripProvider(key, provider).toLowerCase(),
        fields: toCatalogFields(entry),
      })
    }
  }
  candidates.sort((a, b) => b.id.length - a.id.length)

  return {
    candidateCount: exact.size,
    matchedProviders: matched,
    resolve(litellmModelName: string): CatalogFields | null {
      const norm = litellmModelName.toLowerCase()
      const direct = exact.get(norm)
      // An exact key wins outright — but only when the entry actually carries
      // something. `trim()` keeps any entry with one known field, so an
      // enriched table whose entry has `litellm_provider` and mistyped cost
      // keys reaches here as {}; returning it would swallow the substring pass
      // that could still have priced the model.
      if (direct && Object.keys(direct).length > 0) return direct
      for (const c of candidates) {
        if (isBoundedSubstring(norm, c.id)) return c.fields
      }
      return null
    },
  }
}

/**
 * Drop a leading `<provider>/` from a table key: `azure/gpt-5.4` → `gpt-5.4`,
 * so it can be matched inside a gateway-prefixed model name.
 *
 * Only that one leading segment. Regional keys (`azure/eu/gpt-5.1`) keep their
 * `eu/` and therefore never win a substring match — which is correct, since
 * their prices are region-specific and a model name says nothing about region.
 */
function stripProvider(key: string, provider: string): string {
  const prefix = `${provider}/`
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

/**
 * True if `needle` occurs in `haystack` not flanked by an alphanumeric
 * char, so "gpt-5.4" matches "ai-gateway-gpt-5.4" and "…gpt-5.4-mini" but
 * NOT "…gpt-5.45".
 */
function isBoundedSubstring(haystack: string, needle: string): boolean {
  if (!needle) return false
  let from = 0
  for (;;) {
    const i = haystack.indexOf(needle, from)
    if (i === -1) return false
    const before = i === 0 ? '' : haystack[i - 1]!
    const after = haystack[i + needle.length] ?? ''
    if (!isAlnum(before) && !isAlnum(after)) return true
    from = i + 1
  }
}

function isAlnum(ch: string): boolean {
  return ch !== '' && /[a-z0-9]/.test(ch)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Map a price-table entry to config fields.
 *
 * Cost goes through `buildCost`, the same mapper the (unused) /v1/model/info
 * reader uses: the table states costs in USD per TOKEN and opencode wants USD
 * per 1M, so the ×1e6 scaling is not optional. The 200k tier and the deliberate
 * non-mapping of `*_above_272k_tokens` come with it.
 */
export function toCatalogFields(entry: Record<string, unknown>): CatalogFields {
  const fields: CatalogFields = {}

  const cost = buildCost(entry as LiteLLMModelInfo)
  if (cost && !isAllZero(cost)) fields.cost = cost

  // LiteLLM semantics: max_input_tokens = context window; max_output_tokens =
  // max completion, with max_tokens as its legacy alias (NOT total context).
  const context = num(entry.max_input_tokens)
  const output = num(entry.max_output_tokens) ?? num(entry.max_tokens)
  if (context != null && output != null) fields.limit = { context, output }

  if (entry.supports_reasoning === true) fields.reasoning = true
  if (entry.supports_function_calling === true) fields.tool_call = true
  if (entry.supports_vision === true) fields.attachment = true

  const input: string[] = ['text']
  if (entry.supports_vision === true) input.push('image')
  if (entry.supports_pdf_input === true) input.push('pdf')
  if (entry.supports_audio_input === true) input.push('audio')
  if (input.length > 1) fields.modalities = { input, output: ['text'] }

  return fields
}

/**
 * A cost of exactly zero across the board, which the table means as "we have
 * no number for this" — not as "this model is free".
 *
 * LiteLLM's published table carries 124 such entries, and several are plainly
 * billable chat models (`deepseek-v3-2-251201`, `codestral/codestral-latest`,
 * `anthropic.claude-mythos-preview`). Under the old models.dev source they
 * could not be reached; exact-key matching reaches them, and emitting
 * `{input: 0, output: 0}` would display a billable model as free — the precise
 * failure this plugin exists to prevent, and worse than showing nothing.
 *
 * So the model is injected UNPRICED and named in the startup log's "no
 * pricing" list, where it can be seen and reported upstream. A genuinely free
 * model loses its `$0` display; that is the cheap side of this trade.
 *
 * Deliberately not done inside `buildCost` — its contract keeps a real 0 for a
 * free tier, which is right for a per-deployment reading. It is the TABLE's
 * zeroes that are unreliable.
 */
function isAllZero(cost: CostBlock): boolean {
  return (
    cost.input === 0 &&
    cost.output === 0 &&
    !cost.cache_read &&
    !cost.cache_write &&
    !cost.context_over_200k
  )
}

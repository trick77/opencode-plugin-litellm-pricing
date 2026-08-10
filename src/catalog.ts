// The pricing source.
//
// Cost is taken from opencode's own models.dev-backed catalog — fetched via
// the plugin client (no external network, always the catalog version opencode
// itself runs) — matched to the LiteLLM model by name.
//
// LiteLLM's own per-model prices are deliberately not used: they depend on the
// deployment having base_model set correctly, which is easy to get wrong and
// then silently bills $0. Name-matching gives the same answer for every key,
// through one code path.

import type { PluginInput } from '@opencode-ai/plugin'
import type { CostBlock, CostTier } from './types.ts'

type Client = PluginInput['client']

// Providers we match against, in precedence order. These LiteLLM
// deployments are Azure/OpenAI; both carry the full model line in models.dev
// and price it identically, so Azure is preferred with OpenAI as an
// equivalent fallback. Restricting to these two avoids false matches against
// third-party aggregators that use slash-laden ids.
const PREFERRED_PROVIDERS = ['azure', 'openai']

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
  /** How many priceable models the catalog was built from. */
  readonly candidateCount: number
  /** Which of PREFERRED_PROVIDERS actually contributed candidates. */
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
  id: string // lowercased models.dev id, e.g. "gpt-5.4-mini"
  fields: CatalogFields
}

const CATALOG_TIMEOUT_MS = 30_000

let catalogPromise: Promise<Catalog | null> | undefined
let catalogStatus: CatalogStatus = { state: 'loading' }
let readyCatalog: Catalog | null = null

/** What happened on the (single) catalog load. Safe to call before it runs. */
export function getCatalogStatus(): CatalogStatus {
  return catalogStatus
}

/** Load opencode's model catalog once per process (memoized). */
export function getCatalog(client: Client): Promise<Catalog | null> {
  if (!catalogPromise) {
    catalogPromise = load(client)
    // A promise cannot be inspected synchronously, so latch the result for
    // catalogIfReady().
    void catalogPromise.then((c) => {
      readyCatalog = c
    })
  }
  return catalogPromise
}

/**
 * Reject after CATALOG_TIMEOUT_MS so a hung client call can't leak forever.
 *
 * This is a leak guard, not a startup guard: nothing awaits the load any more.
 * `client.config.providers()` is served by the same process that is loading
 * plugins and building the config, so it cannot answer while a plugin is
 * blocked waiting on it — measured against a live server, an awaited call
 * timed out at 2002 ms while the same call, left unawaited, resolved at
 * 2154 ms, immediately after the `config` hook returned. Awaiting it during
 * startup is a deadlock at any timeout value, which is why startCatalogLoad
 * fires it and walks away.
 */
function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('catalog load timed out')), CATALOG_TIMEOUT_MS)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Kick the catalog load off without waiting for it. Never throws.
 *
 * Deliberately not awaited — see withTimeout above. The `config` hook runs
 * several times per run, so a load started here lands in time for a later
 * invocation to price what the first one could only inject bare.
 */
export function startCatalogLoad(client: Client): void {
  void getCatalog(client)
}

/**
 * The catalog if it has already finished loading, else null.
 *
 * Callers on the startup path must use this rather than awaiting getCatalog:
 * awaiting is what deadlocks.
 */
export function catalogIfReady(): Catalog | null {
  return readyCatalog
}

/** Clear the memoized catalog — used by tests. */
export function resetCatalogCache(): void {
  catalogPromise = undefined
  catalogStatus = { state: 'loading' }
  readyCatalog = null
}

/**
 * Where the price table comes from, best first.
 *
 * `provider.list` (/provider) returns `all`: every models.dev provider,
 * independent of what the user has configured or authenticated. That is what a
 * price table needs. `config.providers` returns only configured/detected
 * providers — on a machine with no Azure credentials it omits `azure`
 * entirely, and the `openai` entry it does return is the user's own, which
 * reports every cost as 0. Sourcing prices from it means a model priced $0 by
 * accident of the reader's config, which is the exact failure this plugin
 * exists to prevent. It stays only as a fallback for hosts without /provider.
 *
 * It has a second, load-bearing role. Nothing here can be awaited during
 * plugin load: the server that answers these calls cannot answer anything
 * while a plugin blocks on it, so awaiting either endpoint deadlocks until the
 * timeout — measured at 60 s for both. The catalog therefore lands after the
 * first `config` pass has already injected models bare, and only a LATER pass
 * can price them. Requesting config.providers is what prompts opencode to
 * rebuild the config and run that later pass; with provider.list alone the
 * hook is invoked exactly once and the prices never get in.
 *
 * Both endpoints return the same nested model shape at runtime
 * (`capabilities.toolcall`, `cost.cache.read`, `experimentalOver200K`), so
 * `toCatalogFields` parses either. Note the SDK's generated type for /provider
 * describes a flatter shape than the server actually sends; the shape below is
 * what a live 1.18 server returns.
 */
const SOURCES: Array<{ name: string; fetch: (client: Client) => Promise<unknown> }> = [
  {
    name: 'provider.list',
    fetch: async (client) => {
      const r = (await client.provider.list({})) as unknown as {
        data?: { all?: unknown }
        all?: unknown
      }
      return r?.data?.all ?? r?.all
    },
  },
  {
    name: 'config.providers',
    fetch: async (client) => {
      const r = (await client.config.providers({})) as unknown as {
        data?: { providers?: unknown }
        providers?: unknown
      }
      return r?.data?.providers ?? r?.providers
    },
  },
]

async function load(client: Client): Promise<Catalog | null> {
  const t0 = Date.now()
  // Fired together, not in sequence. Sequencing would make the fallback wait
  // out the primary's timeout, and the window in which a later `config` pass
  // can still use the result is short — see startCatalogLoad.
  const attempts = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        const providers = await withTimeout(source.fetch(client))
        if (!Array.isArray(providers))
          return { source, reason: 'no provider list in response', catalog: null }
        const catalog = buildFromProviders(providers)
        // Providers we can't price are no better than no providers.
        if (catalog.candidateCount === 0)
          return { source, reason: 'no priceable providers', catalog: null }
        return { source, reason: '', catalog }
      } catch (err) {
        return {
          source,
          reason: err instanceof Error ? err.message : String(err),
          catalog: null,
        }
      }
    }),
  )

  // SOURCES order is preference order, so the first success wins.
  const won = attempts.find((a) => a.catalog)
  if (won?.catalog) {
    catalogStatus = {
      state: 'ok',
      source: won.source.name,
      elapsedMs: Date.now() - t0,
      candidateCount: won.catalog.candidateCount,
      matchedProviders: won.catalog.matchedProviders,
    }
    return won.catalog
  }
  catalogStatus = {
    state: 'unavailable',
    reason:
      `${attempts.map((a) => `${a.source.name}: ${a.reason}`).join('; ')} ` +
      `(after ${Date.now() - t0}ms)`,
  }
  return null
}

/**
 * Build a name resolver from a list of opencode provider objects. Pure and
 * exported for testing.
 */
export function buildFromProviders(providers: unknown[]): Catalog {
  const byId = new Map<string, Record<string, unknown>>()
  for (const p of providers) {
    if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
      byId.set((p as { id: string }).id, p as Record<string, unknown>)
    }
  }

  // Candidates in provider-precedence order, then sorted longest id first so
  // the first substring match is the most specific (…-mini beats base) and,
  // on a length tie, comes from the preferred provider (stable sort).
  const candidates: Candidate[] = []
  const matched: string[] = []
  for (const provider of PREFERRED_PROVIDERS) {
    const models = byId.get(provider)?.models
    if (!models || typeof models !== 'object') continue
    matched.push(provider)
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      const m = (raw ?? {}) as Record<string, unknown>
      const id = typeof m.id === 'string' ? m.id : key
      candidates.push({ id: id.toLowerCase(), fields: toCatalogFields(m) })
    }
  }
  candidates.sort((a, b) => b.id.length - a.id.length)

  return {
    candidateCount: candidates.length,
    matchedProviders: matched,
    resolve(litellmModelName: string): CatalogFields | null {
      const norm = litellmModelName.toLowerCase()
      for (const c of candidates) {
        if (isBoundedSubstring(norm, c.id)) return c.fields
      }
      return null
    },
  }
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

/** Map an opencode catalog model (models.dev V2 shape) to config fields. */
function toCatalogFields(m: Record<string, unknown>): CatalogFields {
  const fields: CatalogFields = {}

  const cost = toCost(m.cost)
  if (cost) fields.cost = cost

  const limit = m.limit as { context?: unknown; output?: unknown } | undefined
  const context = num(limit?.context)
  const output = num(limit?.output)
  if (context != null && output != null) fields.limit = { context, output }

  const caps = m.capabilities as Record<string, unknown> | undefined
  if (caps?.reasoning === true) fields.reasoning = true
  if (caps?.toolcall === true) fields.tool_call = true
  if (caps?.attachment === true) fields.attachment = true

  const modalities = toModalities(caps?.input as Record<string, unknown> | undefined)
  if (modalities) fields.modalities = modalities

  return fields
}

// models.dev costs (as opencode exposes them) are already USD per 1M tokens,
// so they map straight through — no ×1e6 scaling.
function toCost(raw: unknown): CostBlock | undefined {
  const cost = raw as
    | { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown }; experimentalOver200K?: unknown }
    | undefined
  const input = num(cost?.input)
  const output = num(cost?.output)
  if (input == null || output == null) return undefined

  const block: CostBlock = { input, output }
  const cacheRead = num(cost?.cache?.read)
  const cacheWrite = num(cost?.cache?.write)
  if (cacheRead) block.cache_read = cacheRead
  if (cacheWrite) block.cache_write = cacheWrite

  const over = cost?.experimentalOver200K as
    | { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } }
    | undefined
  const overIn = num(over?.input)
  const overOut = num(over?.output)
  if (overIn != null && overOut != null) {
    const tier: CostTier = { input: overIn, output: overOut }
    const tr = num(over?.cache?.read)
    const tw = num(over?.cache?.write)
    if (tr) tier.cache_read = tr
    if (tw) tier.cache_write = tw
    block.context_over_200k = tier
  }
  return block
}

function toModalities(
  input: Record<string, unknown> | undefined,
): { input: string[]; output: string[] } | undefined {
  if (!input) return undefined
  const mods: string[] = ['text']
  if (input.image === true) mods.push('image')
  if (input.audio === true) mods.push('audio')
  if (input.pdf === true) mods.push('pdf')
  if (input.video === true) mods.push('video')
  if (mods.length <= 1) return undefined
  return { input: mods, output: ['text'] }
}

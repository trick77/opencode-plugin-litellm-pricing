// opencode-plugin-litellm-pricing
//
// An opencode V2 plugin that discovers models from a LiteLLM proxy and adds
// them to the provider's model inventory — each carrying real per-model
// `cost` tiers, so opencode's cost display matches what LiteLLM bills.
//
// Everything comes from the proxy itself: what models the key can see
// (/v1/models), and what each one costs, what kind of model it is, and what it
// can do (/v1/model/info). No second URL, no price table, no local cache.
//
// This needs **LiteLLM v1.96.0 or newer**. That release moved `/model/info`
// and `/v1/model/info` into `llm_api_routes`, which is what a key created with
// `key_type: "llm_api"` carries; before it, reading pricing meant handing the
// plugin a key with admin-shaped privileges. Against an older proxy — or a key
// scoped to exclude the route — models are still discovered and injected, just
// unpriced.
//
// The prices are LiteLLM's own resolved numbers, config overrides included, so
// opencode's cost display matches what the gateway bills. A deployment whose
// `base_model` mapping is missing or wrong resolves to no cost at all rather
// than to a wrong one: those models are injected unpriced and named in the log.
//
// `settings.baseURL` (V1: `options.baseURL`) is required. The plugin talks to
// that URL and nothing else: there is no default and no port auto-detection.
//
// Requires opencode 2.x. Configure in opencode.json:
//
//   {
//     "plugins": ["opencode-plugin-litellm-pricing@1.0.0"],
//     "providers": {
//       "litellm": {
//         "name": "LiteLLM (proxy)",
//         "package": "aisdk:@ai-sdk/openai-compatible",
//         "settings": {
//           "baseURL": "https://litellm.example.com/v1",
//           "apiKey": "{env:LITELLM_API_KEY}"
//         }
//       }
//     }
//   }
//
// A V1-shaped `provider.litellm` block with `npm` + `options` works too:
// opencode normalizes it into the shape above before any plugin sees it.

// Types only. Nothing from @opencode/* is imported at runtime: the package is a
// devDependency, so the published plugin has no runtime dependencies at all
// and cannot clash with the @opencode/plugin copy opencode itself ships.
import type { Model, Plugin } from '@opencode/plugin'
import type { ProviderEditor } from '@opencode/plugin/promise/provider'
import type { DeepMutable } from '@opencode/plugin/promise/types'
import type { LiteLLMModel, LiteLLMModelInfo, ModelSpec } from './types.ts'
import {
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
  resolveApiKey,
} from './litellm-api.ts'
import { enrichModel, modelSpecFromProxy } from './build-model.ts'

/** The V2 plugin id. Plugin storage and diagnostics are keyed by it. */
export const PLUGIN_ID = 'opencode-plugin-litellm-pricing'

// Default provider id — kept identical to the npm package name so the
// `plugins` entry and the `providers` key in opencode.json read the same.
const PROVIDER_ID = 'opencode-plugin-litellm-pricing'
// The pre-0.3.0 package name, which was also the default provider id. Still
// matched, so an opencode.json written against the old name keeps working
// after the rename — the key is user-facing config, not an internal constant.
const LEGACY_PROVIDER_ID = 'opencode-litellm-pricing'

/**
 * opencode's native OpenAI-compatible route. Set on a matched provider only
 * when its config named no package at all; a configured one (V1 `npm:
 * "@ai-sdk/openai-compatible"` normalizes to `aisdk:@ai-sdk/openai-compatible`)
 * is left alone.
 */
const OPENAI_COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible'

/**
 * The reasoning variants a `supports_reasoning` model gets. These are exactly
 * what opencode itself derives for an OpenAI-compatible chat model that
 * supports reasoning effort (`openaiChat` in core's variant.ts): LiteLLM takes
 * `reasoning_effort` and translates it for whatever backend serves the model.
 */
const REASONING_EFFORTS = ['low', 'medium', 'high'] as const

/** How many unpriced model ids to name inline before summarising the rest. */
const UNPRICED_LIST_LIMIT = 15

/**
 * A failed discovery is retried on a timer after this long (or on the next
 * provider change, but never sooner). opencode is a long-running service in V2: a proxy that was down
 * at startup must not leave the picker empty until a restart, and a proxy
 * that stays down must not be hammered on every unrelated reload.
 */
const RETRY_AFTER_MS = 60_000

/**
 * Backoff for resubscribing to opencode's event stream after it errored or
 * ended. Doubles per failure, capped; reset by the first event that arrives.
 */
const RESUBSCRIBE_MIN_MS = 1_000
const RESUBSCRIBE_MAX_MS = 60_000

/** Timing knobs — overridden by tests only. */
export interface Timing {
  retryAfterMs: number
  resubscribeMinMs: number
  resubscribeMaxMs: number
}

const DEFAULT_TIMING: Timing = {
  retryAfterMs: RETRY_AFTER_MS,
  resubscribeMinMs: RESUBSCRIBE_MIN_MS,
  resubscribeMaxMs: RESUBSCRIBE_MAX_MS,
}

/**
 * Does a provider id / settings block designate a LiteLLM-backed provider?
 * Both the current and the pre-rename package name are accepted as ids. The
 * flags are read off `settings`, which is where V1 `options.*` lands after
 * opencode's config normalization.
 */
export function isLiteLLMProvider(providerId: string, settings: Record<string, unknown>): boolean {
  if (providerId === PROVIDER_ID) return true
  if (providerId === LEGACY_PROVIDER_ID) return true
  if (providerId === 'litellm') return true
  if (providerId.startsWith('litellm-') || providerId.startsWith('litellm_')) return true
  return (
    settings.litellm === true ||
    settings.litellmCompatible === true ||
    settings['litellm-compatible'] === true ||
    settings.litellm_compatible === true
  )
}

/** Read a string-valued header map, or `undefined` if there is none. */
function readHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Write a spec onto a `Model.Info` draft seeded by opencode. */
function applySpec(model: DeepMutable<Model.Info>, spec: ModelSpec): void {
  model.name = spec.name
  // V2's limit fields are integers; LiteLLM's are in practice, but a stray
  // float must not make opencode reject the whole model.
  if (spec.limit) {
    model.limit.context = Math.trunc(spec.limit.context)
    model.limit.output = Math.trunc(spec.limit.output)
  }
  model.capabilities.input = [...spec.input]
  if (spec.tools !== undefined) model.capabilities.tools = spec.tools
  // Fresh tier objects per model: one spec is never shared between two
  // drafts, but a copy keeps that true even if it ever is. The cast only
  // drops the `Money` brand (see `CostTier` in types.ts).
  model.cost = spec.cost.map((tier) => structuredClone(tier)) as unknown as DeepMutable<Model.Cost>[]
  if (spec.reasoning) {
    model.variants = REASONING_EFFORTS.map((effort) => ({
      id: effort as Model.VariantID,
      settings: { reasoningEffort: effort },
    }))
  }
}

/** One provider's discovered inventory, as the transform replays it. */
interface Injection {
  /** Identity of the inputs that produced this inventory (URL, key, headers). */
  key: string
  /** Normalized: no trailing slash, no `/v1`. */
  baseURL: string
  /** Chat models only, in proxy order. */
  specs: Array<[string, ModelSpec]>
  /** Counted at discovery time: non-chat, wildcard and malformed entries. */
  filtered: number
}

/** What the last fold did per provider — read back for the summary line. */
interface FoldStats {
  added: string[]
  preexisting: number
}

type Report = (level: 'info' | 'warn', message: string) => void

/**
 * Turn one /v1/models + /v1/model/info pair into an injection.
 *
 * Every discovered entry lands in exactly one bucket, so the summary can be
 * read as a complete account of what LiteLLM offered: a spec, or filtered.
 */
export function buildInjection(
  key: string,
  baseURL: string,
  discovered: LiteLLMModel[],
  infoByName: Map<string, LiteLLMModelInfo> | null,
): Injection {
  const specs: Array<[string, ModelSpec]> = []
  const seen = new Set<string>()
  let filtered = 0
  for (const model of discovered) {
    // Skip malformed entries rather than throwing out of discovery.
    if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) {
      filtered++
      continue
    }
    // Wildcard entries (`deepseek/*`) are access rules, not callable
    // models — invoking one sends a literal `*` upstream.
    if (model.id.includes('*')) {
      filtered++
      continue
    }
    // /v1/model/info is keyed by model_name, which is exactly the id
    // /v1/models reports — no alias resolution needed.
    const info = infoByName?.get(model.id)
    const enriched = info ? enrichModel(model, info) : model
    const spec = modelSpecFromProxy(enriched, info)
    if (!spec) {
      filtered++
      continue
    }
    seen.add(model.id)
    specs.push([model.id, spec])
  }
  return { key, baseURL, specs, filtered }
}

/**
 * The plugin body. Exported separately from the definition so tests can drive
 * it with a fake context.
 */
export function setupLiteLLMPricing(
  ctx: Plugin.Context,
  report: Report = consoleReport,
  timing: Timing = DEFAULT_TIMING,
) {
  // Why this is not "read the config, fetch, inject" any more:
  //
  // In V2 there is no mutable config object to rewrite. Providers come from
  // opencode's provider registry, built by replaying every registered
  // `ctx.provider.transform` in order. The transform that turns opencode.json's
  // `providers` (and normalized V1 `provider`) into registry entries is a
  // built-in that activates AFTER every user plugin. So during `setup`, the
  // LiteLLM provider this plugin is meant to enrich does not exist yet — not
  // in `ctx.provider.list()`, not in a transform registered from here.
  //
  // So the plugin follows the registry instead:
  //
  //   1. Watch `provider.updated`. The first one after boot is the config
  //      provider registering itself; later ones are config edits.
  //   2. On each, list the providers and pick the LiteLLM ones. Their
  //      `settings` carry baseURL/apiKey, `{env:…}` already substituted.
  //   3. Discover asynchronously, outside any transform. Transforms must be
  //      synchronous and replayable.
  //   4. Register ONE provider transform the first time something was found,
  //      and `reload()` it after that. Registering late is what puts it after
  //      the config provider's transform, so it sees (and keeps) the user's
  //      hand-written models and can finish the provider's wiring.
  //
  // Nothing here is awaited by `setup` itself. A setup that blocks on network
  // I/O would hold up every plugin after it — and the config provider is one
  // of those, so waiting for it from inside setup could never succeed.

  const injections = new Map<string, Injection>()
  const stats = new Map<string, FoldStats>()
  const attempts = new Map<string, { key: string; failedAt?: number }>()
  const warnedNoBaseURL = new Set<string>()
  const warnedStale = new Set<string>()
  let registered = false
  let disposed = false
  // Aborts the event subscription and every in-flight proxy request.
  const controller = new AbortController()
  // One pending retry at a time; unref'd so it never keeps a process alive.
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  // The transform. Replayed by opencode on every rebuild, so it reads only
  // the captured `injections` and writes only to the editor (plus `stats`,
  // which is a pure function of the fold and read back for the log).
  //
  // `stats` stays, even though it is a side channel: which discovered ids the
  // user already hand-curated is only knowable inside the fold —
  // `ctx.provider.list()` returns provider infos without their models. Deriving
  // the summary from the injection alone would count curated models as added.
  const transform = (editor: ProviderEditor) => {
    stats.clear()
    for (const [providerId, injection] of injections) {
      // Removed from opencode.json since discovery: inject nothing, and do not
      // let `update` recreate the provider as an empty shell.
      const current = editor.get(providerId)
      if (!current) continue
      // The config moved to another proxy since this inventory was fetched:
      // inject nothing until it is rediscovered, and leave the new baseURL
      // untouched. Rewriting it from the stale injection would hide the edit
      // from the next sync — and send every request to the old proxy.
      const configuredBase = current.provider.settings?.baseURL
      if (typeof configuredBase !== 'string' || normalizeBaseURL(configuredBase) !== injection.baseURL) {
        continue
      }

      // Finish the provider's wiring.
      //
      // The baseURL is rewritten, not merely defaulted. `normalizeBaseURL`
      // accepts both `https://host` and `https://host/v1` — discovery works
      // either way because `buildAPIURL` appends `/v1/models` itself — but the
      // OpenAI-compatible route POSTs `${baseURL}/chat/completions`, so the
      // string handed to it MUST carry the `/v1`. Passing the user's spelling
      // through unchanged is what made a `/v1`-less baseURL produce a picker
      // full of correctly-priced models that 404 on every request.
      //
      // Idempotent for the documented form: `https://x/v1` normalizes to
      // `https://x`, and this puts the `/v1` back.
      editor.update(providerId, (provider) => {
        if (!provider.package) provider.package = OPENAI_COMPATIBLE_PACKAGE
        provider.settings = { ...provider.settings, baseURL: `${injection.baseURL}/v1` }
      })

      // Never overwrite a user-curated model. The config provider's transform
      // ran before this one, so anything under `providers.<id>.models` is
      // already in the record.
      const record = editor.get(providerId)
      const fold: FoldStats = { added: [], preexisting: 0 }
      for (const [id, spec] of injection.specs) {
        if (record?.models.has(id)) {
          fold.preexisting++
          continue
        }
        editor.models.update(providerId, id, (model) => applySpec(model, spec))
        fold.added.push(id)
      }
      stats.set(providerId, fold)
    }
  }

  const summarize = (providerId: string, injection: Injection, infoReadable: boolean) => {
    const fold = stats.get(providerId)
    if (!fold) return
    const specs = new Map(injection.specs)
    const added = fold.added.length
    const unpricedIds = fold.added.filter((id) => specs.get(id)!.cost.length === 0)
    const priced = added - unpricedIds.length

    // Pricing coverage is stated over the models actually injected, not over
    // everything discovered: non-chat and wildcard entries never reach the
    // picker, so they can't bill anything and aren't a pricing problem.
    //
    // Counts only, on one short line. `hidden` folds every reason a
    // discovered model did not get injected: non-chat, wildcard, malformed,
    // and ids already in the user's config.
    //
    // Nothing priced at all is the systematic-failure shape, and the cause is
    // almost always the same one — so name it, with the version that fixes
    // it. A per-model gap (an unmapped base_model) shows up in the `no
    // pricing:` line below instead.
    const hidden = injection.filtered + fold.preexisting
    const nothingPriced = added > 0 && priced === 0
    report(
      nothingPriced ? 'warn' : 'info',
      `[litellm-pricing] ${providerId}: ${added} models, ${priced} priced, ${hidden} hidden` +
        (nothingPriced && !infoReadable
          ? ' — /v1/model/info unreadable: needs LiteLLM v1.96.0+ and a key allowed to call it'
          : ''),
    )

    // Name them: a count alone doesn't say which model will read as free.
    if (unpricedIds.length > 0) {
      const shown = unpricedIds.slice(0, UNPRICED_LIST_LIMIT)
      const rest = unpricedIds.length - shown.length
      report(
        'info',
        `[litellm-pricing]   no pricing: ${shown.join(', ')}` + (rest > 0 ? ` … +${rest} more` : ''),
      )
    }
  }

  // A failed attempt is retried on a timer, not only on the next provider
  // change: a proxy that was down when opencode started must not leave the
  // picker empty until a restart. The retry floor in `syncOnce` still applies.
  const scheduleRetry = (ms: number) => {
    if (disposed || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      sync()
    }, ms)
    retryTimer.unref?.()
  }
  const fail = (providerId: string, key: string) => {
    attempts.set(providerId, { key, failedAt: Date.now() })
    scheduleRetry(timing.retryAfterMs)
  }

  // Discover one provider. Never throws: every failure is reported, recorded
  // as failed (so it is retried) and leaves the previous inventory in place.
  const discover = async (
    providerId: string,
    key: string,
    baseURL: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
  ): Promise<void> => {
    attempts.set(providerId, { key })

    // Both requests at once. /v1/models is the gate — its failure means
    // "offline" (no standalone health probe: it is the same request a probe
    // would make). /v1/model/info is best-effort by necessity: a proxy older
    // than LiteLLM v1.96.0, or a key scoped to exclude the route, refuses it.
    // Every model is still injected then — unpriced, and classified by the
    // `mode` on /v1/models if it carries one, else by the id heuristics.
    let discovered: LiteLLMModel[]
    let infoByName: Map<string, LiteLLMModelInfo> | null
    try {
      ;[discovered, infoByName] = await Promise.all([
        discoverLiteLLMModels(baseURL, apiKey, headers, controller.signal),
        discoverLiteLLMModelInfo(baseURL, apiKey, headers, controller.signal).catch(() => null),
      ])
    } catch (err) {
      if (disposed) return
      fail(providerId, key)
      report(
        'warn',
        `[litellm-pricing] Model discovery failed for provider "${providerId}" at ${baseURL}: ` +
          (err instanceof Error ? err.message : String(err)),
      )
      return
    }
    if (disposed) return
    if (discovered.length === 0) {
      fail(providerId, key)
      report(
        'warn',
        `[litellm-pricing] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
      )
      return
    }

    const injection = buildInjection(key, baseURL, discovered, infoByName)
    const previous = injections.get(providerId)
    injections.set(providerId, injection)
    try {
      if (!registered) {
        await ctx.provider.transform(transform)
        // Only now: a registration that failed must be retried, not assumed.
        registered = true
      } else {
        await ctx.provider.reload()
      }
      // A read forces the rebuild, so `stats` reflects this injection.
      await ctx.provider.list()
    } catch (err) {
      // opencode refused the registration or the rebuild. Roll back so the
      // key does not read as "done", and retry like any other failure.
      if (previous) injections.set(providerId, previous)
      else injections.delete(providerId)
      if (disposed) return
      fail(providerId, key)
      report(
        'warn',
        `[litellm-pricing] provider "${providerId}": could not apply discovered models: ` +
          (err instanceof Error ? err.message : String(err)),
      )
      return
    }
    attempts.delete(providerId)
    summarize(providerId, injection, infoByName !== null)
  }

  const syncOnce = async () => {
    const listed = await ctx.provider.list()
    for (const provider of listed.data) {
      // Unloaded mid-sync: stop before the next provider, not after all of
      // them. In-flight requests are aborted through `controller`.
      if (disposed) return
      const providerId = provider.id
      const settings = (provider.settings ?? {}) as Record<string, unknown>
      if (!isLiteLLMProvider(providerId, settings)) continue

      // The configured URL is the only URL. Nothing is guessed, nothing is
      // probed locally. Read from the provider's own settings, never from the
      // value this plugin rewrote: `normalizeBaseURL` makes both spellings
      // the same key, so the rewrite does not trigger a second discovery.
      const configuredBase = typeof settings.baseURL === 'string' ? settings.baseURL : undefined
      if (!configuredBase) {
        if (!warnedNoBaseURL.has(providerId)) {
          warnedNoBaseURL.add(providerId)
          report(
            'warn',
            `[litellm-pricing] provider "${providerId}" has no settings.baseURL (V1: options.baseURL) — ` +
              'set it to your LiteLLM URL; nothing was injected.',
          )
        }
        continue
      }
      const baseURL = normalizeBaseURL(configuredBase)

      // Pricing used to come from a separately configured price table:
      // `options.catalogURL` (and `options.pricingURL` before 0.7.0). Both
      // are dead now that the proxy answers with its own numbers, and
      // neither is read. Say so rather than ignoring them silently: a config
      // still carrying one was written by someone who wanted pricing, and a
      // dead key is exactly what would make them think it is still doing the
      // work. Warned once per provider per process.
      const staleOption =
        typeof settings.catalogURL === 'string' && settings.catalogURL
          ? 'catalogURL'
          : typeof settings.pricingURL === 'string' && settings.pricingURL
            ? 'pricingURL'
            : undefined
      if (staleOption && !warnedStale.has(providerId)) {
        warnedStale.add(providerId)
        report(
          'warn',
          `[litellm-pricing] provider "${providerId}": ${staleOption} is no longer read — ` +
            'pricing now comes from the proxy itself (/v1/model/info, LiteLLM v1.96.0+). ' +
            'Remove it.',
        )
      }

      // An empty apiKey is what opencode substitutes for an unset
      // `{env:VAR}`, so it falls through to the LiteLLM env vars.
      const configuredKey =
        typeof settings.apiKey === 'string' && settings.apiKey ? settings.apiKey : undefined
      const apiKey = resolveApiKey(configuredKey)
      // `customHeaders` is this plugin's own V1 option; `headers` is where V2
      // (and a V1 `options.headers`) puts provider-wide request headers.
      // Both reach the proxy — a Cloudflare Access header the model calls need
      // is needed by discovery too.
      const headers = readHeaders({
        ...(provider.headers ?? {}),
        ...(readHeaders(settings.customHeaders) ?? {}),
      })

      // Re-discover only when an input changed. Every reload this plugin
      // triggers fires `provider.updated` again; this is what makes that a
      // no-op instead of a loop.
      const key = JSON.stringify([baseURL, apiKey ?? '', headers ?? {}])
      if (injections.get(providerId)?.key === key) continue
      const attempt = attempts.get(providerId)
      if (attempt?.key === key) {
        if (attempt.failedAt === undefined) continue // in flight
        const elapsed = Date.now() - attempt.failedAt
        if (elapsed < timing.retryAfterMs) {
          // Too early — but never just skip: a timer can fire a millisecond
          // ahead of `Date.now()`, and a skipped retry with nothing scheduled
          // would wedge the provider until the next config change.
          scheduleRetry(timing.retryAfterMs - elapsed + 1)
          continue
        }
      }

      // No outer race: every await inside `discover()` is individually bounded
      // (AbortSignal.timeout on both HTTP calls).
      await discover(providerId, key, baseURL, apiKey, headers)
    }
  }

  // One sync at a time; a provider change arriving mid-sync schedules exactly
  // one more pass instead of a second concurrent one.
  //
  // `running` is cleared in the same synchronous step that reads `again` as
  // false (the `finally` below runs with no await in between). Clearing it a
  // microtask later, in a `.finally()` chained on the promise, let an event
  // land in between, see `running` still set, raise `again` after the loop had
  // stopped reading it — and get dropped.
  let running: Promise<void> | undefined
  let again = false
  const loop = async () => {
    try {
      do {
        again = false
        try {
          await syncOnce()
        } catch (err) {
          if (disposed) return
          report(
            'warn',
            `[litellm-pricing] provider sync failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      } while (again && !disposed)
    } finally {
      running = undefined
    }
  }
  const sync = () => {
    if (disposed) return
    if (running) {
      again = true
      return
    }
    running = loop()
  }

  // Follow `provider.updated` for the plugin's whole life. An error or an
  // ended stream is not the end: it is logged once and the subscription is
  // re-opened with backoff, followed by a sync to catch up on whatever was
  // missed meanwhile. Only an abort (the plugin being unloaded) ends it.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  let warnedStream = false
  void (async () => {
    let delay = timing.resubscribeMinMs
    while (!disposed) {
      let problem: string
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          delay = timing.resubscribeMinMs
          if (event.type === 'provider.updated') sync()
        }
        problem = 'ended'
      } catch (err) {
        problem = `failed: ${err instanceof Error ? err.message : String(err)}`
      }
      if (disposed) return
      if (!warnedStream) {
        warnedStream = true
        report('warn', `[litellm-pricing] opencode event stream ${problem}; resubscribing`)
      }
      await sleep(delay)
      delay = Math.min(delay * 2, timing.resubscribeMaxMs)
      sync()
    }
  })()

  // Covers a host where the provider is already registered when this plugin
  // loads (and every test): a no-op when nothing matches yet.
  sync()

  return {
    /** Settles once no sync is running — used by tests. */
    idle: async () => {
      while (running) await running
    },
    dispose: () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      controller.abort()
    },
  }
}

/**
 * console is the only sink a V2 Promise plugin has: its context carries no
 * logger, and V1's `client.app.log` has no V2 counterpart. Measured on 2.0.32:
 * plugin console output does NOT reach `~/.local/share/opencode/log/opencode.log`
 * under the background service; it is visible when opencode runs in the
 * foreground (`opencode serve`).
 */
function consoleReport(level: 'info' | 'warn', message: string): void {
  try {
    if (level === 'warn') console.warn(message)
    else console.log(message)
  } catch {
    // A console that cannot be written to is not a reason to fail discovery.
  }
}

// A plain object, not `Plugin.define(...)`: `define` is an identity function,
// and calling it would be the one runtime import of @opencode/plugin. The
// `satisfies` gives the same type check against V2's definition shape.
export const LiteLLMPricingPlugin = {
  id: PLUGIN_ID,
  setup(ctx: Plugin.Context) {
    const plugin = setupLiteLLMPricing(ctx)
    // Transforms are disposed by opencode with the plugin; the event
    // subscription and any in-flight discovery are ours to stop.
    return () => plugin.dispose()
  },
} satisfies Plugin.Plugin

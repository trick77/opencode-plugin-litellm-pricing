// opencode-plugin-litellm-pricing
//
// An opencode plugin that discovers models from a LiteLLM proxy at startup
// and injects them into the provider's `models` map — each carrying a real
// per-model `cost` block, so opencode's cost display matches what LiteLLM
// bills.
//
// Cost comes from one source: a price table in LiteLLM's
// `model_prices_and_context_window.json` format, matched to each model by name
// (public list prices). The proxy is asked what models the key can see
// (/v1/models) and what kind of model each one is (/model_group/info) — never
// for pricing.
//
// `options.baseURL` is required. The plugin talks to that URL and nothing
// else: there is no default and no port auto-detection.
//
// `options.catalogURL` is required for pricing, and has no default: point it
// at a price table in LiteLLM's `model_prices_and_context_window.json` format.
// LiteLLM's own published table is the obvious choice; an enriched copy — same
// format, plus entries for your gateway's own model names — prices those models
// by exact name instead of by substring match against the public model line.
// Without it, models are still discovered and injected, just unpriced.
//
// The table is also where each model's `mode` comes from — the field that keeps
// embedders and image generators out of the picker. The proxy can supply it too
// (/model_group/info), but LiteLLM closes that route to `key_type: "llm_api"`
// keys, so on those the catalog is the only classification there is.
//
// Configure in opencode.json:
//
//   {
//     "plugin": ["opencode-plugin-litellm-pricing@latest"],
//     "provider": {
//       "opencode-plugin-litellm-pricing": {
//         "npm": "@ai-sdk/openai-compatible",
//         "name": "LiteLLM (proxy)",
//         "options": {
//           "baseURL": "https://litellm.example.com/v1",
//           "apiKey": "{env:LITELLM_API_KEY}",
//           "catalogURL": "https://catalog.example.com/model_prices_and_context_window.json"
//         }
//       }
//     }
//   }

import type { Config, Plugin, PluginInput } from '@opencode-ai/plugin'
import type { LiteLLMModel, LiteLLMModelGroupInfo } from './types.ts'
import type { CatalogFields } from './catalog.ts'
import {
  discoverLiteLLMModelGroups,
  discoverLiteLLMModels,
  normalizeBaseURL,
  resolveApiKey,
} from './litellm-api.ts'
import { configModelFromCatalog, enrichModel, groupInfoToModelInfo } from './build-config-model.ts'
import { getCatalog, getCatalogStatus } from './catalog.ts'

// Default provider id — kept identical to the npm package name so the
// `plugin` and `provider` keys in opencode.json read the same.
const PROVIDER_ID = 'opencode-plugin-litellm-pricing'
// The pre-0.3.0 package name, which was also the default provider id. Still
// matched, so an opencode.json written against the old name keeps working
// after the rename — the key is user-facing config, not an internal constant.
const LEGACY_PROVIDER_ID = 'opencode-litellm-pricing'

// Minimal mutable view of the parts of opencode's config we touch. Typing
// the hook parameter as opencode's `Config` (below) and narrowing to this
// gives real type-checking on the config shape — a `config.providers` typo
// no longer compiles — while still allowing loose model-entry objects.
interface MutableProvider {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, Record<string, unknown>>
}
interface MutableConfig {
  provider?: Record<string, MutableProvider>
}

/**
 * opencode invokes the `config` hook several times per run with a
 * cumulative config object. Track which model ids we already injected, keyed
 * by provider and baseURL, so repeat invocations return early instead of
 * re-querying — and so a re-entry can tell our own earlier entries apart from
 * the user's hand-written ones.
 */
const injectedModelIds = new Map<string, Set<string>>()

/** How many unpriced model ids to name inline before summarising the rest. */
const UNPRICED_LIST_LIMIT = 15

/**
 * Price-table URLs already reported on. The catalog is loaded once per process
 * per URL, so report on each one once too.
 */
const reportedCatalogs = new Set<string>()

/** Clear the once-per-process report guard — used by tests. */
export function resetReportedCatalog(): void {
  reportedCatalogs.clear()
}

/**
 * Does a provider id / options block designate a LiteLLM-backed provider?
 * Both the current and the pre-rename package name are accepted as ids.
 */
function isLiteLLMProvider(providerId: string, options: Record<string, unknown>): boolean {
  if (providerId === PROVIDER_ID) return true
  if (providerId === LEGACY_PROVIDER_ID) return true
  if (providerId === 'litellm') return true
  if (providerId.startsWith('litellm-') || providerId.startsWith('litellm_')) return true
  return (
    options.litellm === true ||
    options.litellmCompatible === true ||
    options['litellm-compatible'] === true ||
    options.litellm_compatible === true
  )
}

/** Read a `customHeaders` map off a provider options block. */
function readCustomHeaders(options: Record<string, unknown>): Record<string, string> | undefined {
  const raw = options.customHeaders
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export const LiteLLMPricingPlugin: Plugin = async (input: PluginInput) => {
  // No catalog preload here. The price-table URL is per-provider config
  // (`options.catalogURL`), and provider options do not exist until the
  // `config` hook runs — so the table is loaded there, awaited before any model
  // is priced. That hook is invoked exactly ONCE (measured under both `serve`
  // and the CLI), so there is no later pass to fill prices in on, and the load
  // must therefore be one that is safe to wait on: see catalog.ts, where every
  // answering branch reads from disk and the network is only ever a background
  // refresh. Asking opencode itself for the table is what used to deadlock.

  // Every message goes to both sinks. console reaches whoever is attached to
  // the opencode server's stdout; client.app.log is the only path into
  // ~/.local/share/opencode/log/opencode.log, which is where anyone asking
  // "why does this model show $0?" after the fact will actually look.
  //
  // Fire-and-forget on purpose: client calls made from inside the `config`
  // hook are re-entrant (see the comment on load() in catalog.ts), so awaiting
  // one here risks stalling startup. A failed log must never be able to break
  // config loading either — hence try/catch and not just `.catch()`: an SDK
  // without `client.app.log` throws synchronously, and that throw would escape
  // the hook and lose every injected model.
  const report = (level: 'info' | 'warn', message: string) => {
    try {
      if (level === 'warn') console.warn(message)
      else console.log(message)
    } catch {
      // A console that cannot be written to is not a reason to fail the hook.
    }
    try {
      void input.client.app
        .log({ body: { service: 'litellm-pricing', level, message } })
        .catch(() => {})
    } catch {
      // Ditto for opencode's own log.
    }
  }

  return {
    config: async (rawConfig: Config) => {
      const config = rawConfig as unknown as MutableConfig
      if (!config.provider) config.provider = {}
      const providers = config.provider

      // Collect matching providers. No synthesized fallback entry: without a
      // configured baseURL there is nothing to discover, so inventing a
      // provider could only ever produce a warning and an empty model list.
      const matched: Array<{ id: string; provider: MutableProvider }> = []
      for (const id of Object.keys(providers)) {
        const provider = providers[id]
        if (provider && typeof provider === 'object') {
          const options = (provider.options ?? {}) as Record<string, unknown>
          if (isLiteLLMProvider(id, options)) matched.push({ id, provider })
        }
      }

      for (const { id: providerId, provider } of matched) {
        const options = (provider.options ?? {}) as Record<string, unknown>
        const configuredBase = typeof options.baseURL === 'string' ? options.baseURL : undefined
        const configuredKey =
          typeof options.apiKey === 'string' && options.apiKey ? options.apiKey : undefined
        const apiKey = resolveApiKey(configuredKey)
        const customHeaders = readCustomHeaders(options)

        // The configured URL is the only URL. Nothing is guessed, nothing is
        // probed locally.
        if (!configuredBase) {
          report(
            'warn',
            `[litellm-pricing] provider "${providerId}" has no options.baseURL — set it to your LiteLLM URL; nothing was injected.`,
          )
          continue
        }
        const baseURL = normalizeBaseURL(configuredBase)

        // The price table this provider prices from, loaded only once the
        // provider is known to be usable: a provider with no baseURL injects
        // nothing, so loading (and reporting on) a table for it is pure noise.
        // Awaiting it is what the hook running exactly once forces: there is
        // no second pass to price into. After the first start it costs nothing
        // — the load answers from the on-disk cache and refreshes in the
        // background (see catalog.ts).
        //
        // There is no default URL, for the same reason there is no default
        // baseURL: the plugin fetches what its operator named and nothing else.
        // An unset catalogURL is a configuration gap to report, not a licence
        // to reach out to a hardcoded third-party host on every fresh install.
        // Discovery still runs — the models are worth having unpriced, and the
        // warning says exactly why they have no cost.
        const catalogURL =
          typeof options.catalogURL === 'string' && options.catalogURL
            ? options.catalogURL
            : undefined
        const catalog = catalogURL ? await getCatalog(catalogURL) : null
        const resolveCatalog = (name: string): CatalogFields | null =>
          catalog?.resolve(name) ?? null

        if (!catalogURL) {
          // Warned once per provider, not once per process: two providers can
          // be misconfigured independently, and naming the one that is missing
          // its table is the whole value of the message.
          //
          // `pricingURL` was this option's name up to 0.6.0. It is not read —
          // renaming it and then quietly falling back would leave two live
          // spellings forever — but a config still carrying only the old key
          // is the one case where "no catalog URL" is misleading, so the
          // message says which key to rename.
          const hasLegacyKey =
            typeof options.pricingURL === 'string' && options.pricingURL
          report(
            'warn',
            `[litellm-pricing] provider "${providerId}" has no options.catalogURL — ` +
              'set it to a model catalog in LiteLLM `model_prices_and_context_window.json` ' +
              'format; every model will be injected without pricing.' +
              (hasLegacyKey ? ' Found options.pricingURL: rename it to catalogURL.' : ''),
          )
        } else if (!reportedCatalogs.has(catalogURL)) {
          // Once per price-table URL, not per provider: two providers sharing a
          // table share its one load, so a second report would only repeat it.
          reportedCatalogs.add(catalogURL)
          const status = getCatalogStatus(catalogURL)
          // `ok` always carries a non-empty catalog — catalogFrom() returns null
          // at zero candidates, so a zero-candidate `ok` cannot be constructed.
          // `stale cache (refreshing)` is a success too, not a degraded state,
          // and must not warn: it is what keeps startup off the network.
          if (status.state === 'ok') {
            // Name the providers the substring pass can draw on — or say it is
            // inert, which is what a table carrying neither azure nor openai
            // entries means: only exact model names will price.
            // Named `substringProviders`, not `providers`: the enclosing
            // scope already has a `providers` — the config's provider map.
            const substringProviders = status.matchedProviders ?? []
            report(
              'info',
              `[litellm-pricing] catalog: ${status.candidateCount} model(s) from ${status.source} — ` +
                (substringProviders.length > 0
                  ? `substring match via ${substringProviders.join(', ')}`
                  : 'exact model names only (no azure/openai entries to match by substring)'),
            )
          } else {
            report(
              'warn',
              `[litellm-pricing] price catalog unavailable from ${catalogURL} ` +
                `(${status.reason}) — every model will be injected without pricing.`,
            )
          }
        }

        // Ensure the provider entry is minimally wired.
        //
        // The baseURL is rewritten, not merely defaulted. `normalizeBaseURL`
        // accepts both `https://host` and `https://host/v1` — discovery works
        // either way because `buildAPIURL` appends `/v1/models` itself — but
        // `@ai-sdk/openai-compatible` POSTs `${baseURL}/chat/completions`, so
        // the string handed to the SDK MUST carry the `/v1`. Passing the user's
        // spelling through unchanged is what made a `/v1`-less baseURL produce
        // a picker full of correctly-priced models that 404 on every request,
        // with the summary below reporting success.
        //
        // Idempotent for the documented form: `https://x/v1` normalizes to
        // `https://x`, and this puts the `/v1` back.
        const actual = provider
        if (!actual.npm) actual.npm = '@ai-sdk/openai-compatible'
        actual.options = { ...actual.options, baseURL: `${baseURL}/v1` }
        if (!actual.models) actual.models = {}
        const models = actual.models

        // Keyed by provider AND baseURL: two matched providers pointed at the
        // same proxy keep separate bookkeeping, since they also keep separate
        // `models` maps.
        const injectedKey = `${providerId}\n${baseURL}`

        const work = async () => {
          const already = injectedModelIds.get(injectedKey)
          if (already && [...already].every((id) => models[id])) return

          // Pricing is never requested from the proxy. LiteLLM's per-model
          // numbers depend on the deployment having base_model set correctly —
          // an easy thing to get wrong, which then bills $0. Matching the model
          // name against the catalog gives the same answer for every key, with
          // one code path.
          //
          // No standalone health probe: /v1/models is the same request a probe
          // would make, and its failure already means "offline".
          let discovered: LiteLLMModel[]
          try {
            discovered = await discoverLiteLLMModels(baseURL, apiKey, customHeaders)
          } catch (err) {
            report(
              'warn',
              `[litellm-pricing] Model discovery failed for provider "${providerId}" at ${baseURL}: ` +
                (err instanceof Error ? err.message : String(err)),
            )
            return
          }

          if (discovered.length === 0) {
            report(
              'warn',
              `[litellm-pricing] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
            )
            return
          }

          // What kind of model each one is. /v1/models carries no `mode`, so
          // without this the non-chat filter can only guess from the id.
          // Strictly best-effort — it is not settled whether this endpoint
          // needs an elevated key, so any failure (refused, missing, slow)
          // falls back to the id heuristics rather than blocking or dropping
          // models.
          let groups: Map<string, LiteLLMModelGroupInfo> | null = null
          try {
            groups = await discoverLiteLLMModelGroups(baseURL, apiKey, customHeaders)
          } catch {
            groups = null
          }

          // Every discovered entry lands in exactly one of these, so the
          // summary can be read as a complete account of what LiteLLM offered:
          // added + priced-subset, and the four reasons a model didn't make it.
          let added = 0
          let priced = 0
          let skipped = 0
          let wildcards = 0
          let preexisting = 0
          let reinjected = 0
          let malformed = 0
          const unpricedIds: string[] = []
          const addedIds = new Set<string>()
          const ours = injectedModelIds.get(injectedKey)
          for (const model of discovered) {
            // Skip malformed entries rather than throwing out of the hook.
            if (!model || typeof model.id !== 'string') {
              malformed++
              continue
            }
            // Wildcard entries (`deepseek/*`) are access rules, not callable
            // models — invoking one sends a literal `*` upstream.
            if (model.id.includes('*')) {
              wildcards++
              continue
            }
            // Never overwrite user-curated entries. An id we injected on an
            // earlier `config` invocation is not one of those — counting it as
            // the user's config would turn a re-entry into a summary claiming
            // the user hand-wrote everything we just added.
            if (models[model.id]) {
              if (ours?.has(model.id)) reinjected++
              else preexisting++
              continue
            }

            // /model_group/info is keyed by model_group, which is exactly
            // the id /v1/models reports — no alias resolution needed.
            const group = groups?.get(model.id)
            const enriched = group ? enrichModel(model, groupInfoToModelInfo(group)) : model

            // Name-match against the price table: an exact key wins outright
            // (an enriched table can carry `ai-gateway/gpt-5.4` itself), and
            // otherwise `ai-gateway-gpt-5.4` resolves to `gpt-5.4` by bounded
            // substring (longest match wins, so `…-mini` beats the base model).
            const fields = resolveCatalog(model.id)
            const entry = configModelFromCatalog(enriched, fields)

            if (!entry) {
              skipped++
              continue
            }
            models[model.id] = entry
            addedIds.add(model.id)
            added++
            if (entry.cost) priced++
            else unpricedIds.push(model.id)
          }

          // Union, not replace: `addedIds` holds only what THIS pass added, so
          // assigning it would drop every id counted as `reinjected` and make
          // the next pass report our own entries as the user's hand-written
          // config — the exact miscount the `reinjected` branch above exists to
          // prevent.
          injectedModelIds.set(injectedKey, new Set([...(ours ?? []), ...addedIds]))

          // Pricing coverage is stated over the models actually injected, not
          // over everything discovered: non-chat and wildcard entries never
          // reach the picker, so they can't bill anything and aren't a pricing
          // problem. `added > 0 && priced === 0` is the systematic-failure
          // shape, so it warns rather than informs.
          report(
            added > 0 && priced === 0 ? 'warn' : 'info',
            `[litellm-pricing] provider "${providerId}": ${discovered.length} discovered, ` +
              `${added} added, pricing for ${priced}/${added}` +
              ` (${skipped} non-chat hidden` +
              (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
              (preexisting > 0 ? `, ${preexisting} already present` : '') +
              (reinjected > 0 ? `, ${reinjected} already injected` : '') +
              (malformed > 0 ? `, ${malformed} malformed` : '') +
              `) from ${baseURL}` +
              // Say which signal did the filtering, so an unexpected model in
              // the picker is diagnosable without instrumenting the plugin.
              // An empty map counts as "did not run": /v1/models returned
              // models, so a group response with no usable entries classified
              // nothing, and claiming otherwise sends the reader down the
              // wrong path.
              //
              // Without the endpoint the catalog's own `mode` still classifies
              // (see categorizeModel), so naming only the id heuristics would
              // understate what ran — and understate how much a catalogURL is
              // worth to someone whose key cannot read /model_group/info.
              (groups?.size
                ? ''
                : catalog
                  ? ' [no /model_group/info — non-chat filtered by catalog mode + name]'
                  : ' [no /model_group/info and no catalog — non-chat filtered by name only]'),
          )

          // Name them: a count alone doesn't say which model will read as free.
          // Capped so a large proxy stays readable — the true total is already
          // in the fraction above.
          if (unpricedIds.length > 0) {
            const shown = unpricedIds.slice(0, UNPRICED_LIST_LIMIT)
            const rest = unpricedIds.length - shown.length
            report(
              'info',
              `[litellm-pricing]   no pricing: ${shown.join(', ')}` +
                (rest > 0 ? ` … +${rest} more` : ''),
            )
          }
        }

        // No outer race: every await inside `work()` is individually bounded
        // (AbortSignal.timeout on the HTTP calls, CATALOG_TIMEOUT_MS on the
        // catalog). A blanket timeout here only ever hid an unbounded call
        // while still charging the user its full duration at startup.
        await work()
      }
    },
  }
}

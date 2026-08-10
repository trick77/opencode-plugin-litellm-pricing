// opencode-plugin-litellm-pricing
//
// An opencode plugin that discovers models from a LiteLLM proxy at startup
// and injects them into the provider's `models` map — each carrying a real
// per-model `cost` block, so opencode's cost display matches what LiteLLM
// bills.
//
// Cost comes from one source: opencode's own models.dev catalog, matched to
// each model by name (public list prices). The proxy is asked what models the
// key can see (/v1/models) and what kind of model each one is
// (/model_group/info) — never for pricing.
//
// `options.baseURL` is required. The plugin talks to that URL and nothing
// else: there is no default and no port auto-detection.
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
//           "apiKey": "{env:LITELLM_API_KEY}"
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
import {
  applyCatalogFields,
  configModelFromCatalog,
  enrichModel,
  groupInfoToModelInfo,
} from './build-config-model.ts'
import { catalogIfReady, getCatalogStatus, startCatalogLoad } from './catalog.ts'

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
 * cumulative config object. Track which model ids we already injected per
 * baseURL so repeat invocations return early instead of re-querying.
 */
const injectedModelIds = new Map<string, Set<string>>()

/** How many unpriced model ids to name inline before summarising the rest. */
const UNPRICED_LIST_LIMIT = 15

/** baseURLs whose models were injected with a catalog available. */
const pricedBaseURLs = new Set<string>()

/** The catalog is loaded once per process, so report on it once too. */
let reportedCatalog = false

/** Clear the once-per-process report guard — used by tests. */
export function resetReportedCatalog(): void {
  reportedCatalog = false
  pricedBaseURLs.clear()
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
  // Start the models.dev catalog load and walk away. That call is answered by
  // the same process that is loading this plugin, so it cannot complete while
  // we block on it — measured on a live server, awaiting it timed out at
  // 2002 ms while the identical unawaited call resolved at 2154 ms, the moment
  // the `config` hook returned. Awaiting therefore deadlocks at ANY timeout,
  // and the old 2s bound turned that into a guaranteed 2s stall that silently
  // lost every price.
  //
  // So: the first `config` pass may run before the catalog exists and injects
  // models bare. opencode calls the hook again, by which time the catalog has
  // landed, and `reprice` fills the cost blocks in.
  startCatalogLoad(input.client)

  // Every message goes to both sinks. console reaches whoever is attached to
  // the opencode server's stdout; client.app.log is the only path into
  // ~/.local/share/opencode/log/opencode.log, which is where anyone asking
  // "why does this model show $0?" after the fact will actually look.
  //
  // Fire-and-forget on purpose: client calls made from inside the `config`
  // hook are re-entrant (see the comment on withTimeout in catalog.ts), so
  // awaiting one here risks stalling startup. A failed log must never be
  // able to break config loading either.
  const report = (level: 'info' | 'warn', message: string) => {
    if (level === 'warn') console.warn(message)
    else console.log(message)
    void input.client.app.log({ body: { service: 'litellm-pricing', level, message } }).catch(() => {})
  }

  return {
    config: async (rawConfig: Config) => {
      const config = rawConfig as unknown as MutableConfig
      if (!config.provider) config.provider = {}
      const providers = config.provider

      // Whatever the catalog knows right now. Never awaited: see the factory.
      const catalog = catalogIfReady()
      const resolveCatalog = (name: string): CatalogFields | null =>
        catalog?.resolve(name) ?? null

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

      // Only once there is a LiteLLM provider to enrich: with none configured
      // the plugin does nothing, and a "no pricing" warning would be noise.
      // Only once the load has settled: 'loading' is not a verdict, and
      // latching the once-per-process guard on it would suppress the real
      // reading when it arrives.
      const status = getCatalogStatus()
      if (matched.length > 0 && !reportedCatalog && status.state !== 'loading') {
        reportedCatalog = true
        if (status.state === 'ok' && (status.candidateCount ?? 0) > 0) {
          report(
            'info',
            `[litellm-pricing] catalog: ${status.candidateCount} model(s) from ` +
              `${status.source} (${(status.matchedProviders ?? []).join(', ')})`,
          )
        } else if (status.state === 'ok') {
          report(
            'warn',
            `[litellm-pricing] catalog loaded from ${status.source} but contained no ` +
              'priceable models — every model will be injected without pricing.',
          )
        } else {
          report(
            'warn',
            '[litellm-pricing] models.dev catalog unavailable ' +
              `(${status.reason}) — every model will be injected without pricing.`,
          )
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

        // Ensure the provider entry exists and is minimally wired.
        if (!providers[providerId]) providers[providerId] = provider
        const actual = providers[providerId]!
        if (!actual.npm) actual.npm = '@ai-sdk/openai-compatible'
        if (!actual.options) actual.options = { baseURL: `${baseURL}/v1` }
        else if (!(actual.options as Record<string, unknown>).baseURL) {
          ;(actual.options as Record<string, unknown>).baseURL = `${baseURL}/v1`
        }
        if (!actual.models) actual.models = {}
        const models = actual.models

        const work = async () => {
          const already = injectedModelIds.get(baseURL)
          if (already && [...already].every((id) => models[id])) {
            // Everything we injected is still in place, so there is nothing to
            // discover. The one reason to keep going is the deadlock above: an
            // earlier pass ran before the catalog existed and injected these
            // models bare, and the catalog has since landed.
            if (!catalog || pricedBaseURLs.has(baseURL)) return
            pricedBaseURLs.add(baseURL)
            let filled = 0
            for (const id of already) {
              const entry = models[id]
              if (!entry || entry.cost) continue
              const fields = resolveCatalog(id)
              if (!fields) continue
              // Reuses the injection-time merge: it only fills absent keys, so
              // a limit already sourced from /model_group/info survives.
              applyCatalogFields(entry, fields)
              if (entry.cost) filled++
            }
            report(
              filled > 0 ? 'info' : 'warn',
              `[litellm-pricing] provider "${providerId}": catalog arrived late, ` +
                `priced ${filled}/${already.size} previously unpriced model(s).`,
            )
            return
          }

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
          const ours = injectedModelIds.get(baseURL)
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

            // Name-match against the models.dev catalog: `ai-gateway-gpt-5.4`
            // resolves to `gpt-5.4` (longest match wins, so `…-mini` beats the
            // base model).
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

          injectedModelIds.set(baseURL, addedIds)
          if (catalog) pricedBaseURLs.add(baseURL)

          // Pricing coverage is stated over the models actually injected, not
          // over everything discovered: non-chat and wildcard entries never
          // reach the picker, so they can't bill anything and aren't a pricing
          // problem. `added > 0 && priced === 0` is the systematic-failure
          // shape, so it warns rather than informs.
          report(
            catalog && added > 0 && priced === 0 ? 'warn' : 'info',
            `[litellm-pricing] provider "${providerId}": ${discovered.length} discovered, ` +
              `${added} added, ` +
              // Without a catalog yet this is not a coverage figure at all —
              // the models are simply not priced *yet*, and saying "0/N" on
              // every normal startup would cry wolf.
              (catalog ? `pricing for ${priced}/${added}` : 'pricing pending (catalog still loading)') +
              ` (${skipped} non-chat hidden` +
              (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
              (preexisting > 0 ? `, ${preexisting} already present` : '') +
              (malformed > 0 ? `, ${malformed} malformed` : '') +
              `) from ${baseURL}` +
              // Say which signal did the filtering, so an unexpected model in
              // the picker is diagnosable without instrumenting the plugin.
              // An empty map counts as "did not run": /v1/models returned
              // models, so a group response with no usable entries classified
              // nothing, and claiming otherwise sends the reader down the
              // wrong path.
              (groups?.size ? '' : ' [no /model_group/info — non-chat filtered by name only]'),
          )

          // Name them: a count alone doesn't say which model will read as free.
          // Capped so a large proxy stays readable — the true total is already
          // in the fraction above.
          if (catalog && unpricedIds.length > 0) {
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

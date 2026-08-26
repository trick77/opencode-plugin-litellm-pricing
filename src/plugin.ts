// opencode-plugin-litellm-pricing
//
// An opencode plugin that discovers models from a LiteLLM proxy at startup
// and injects them into the provider's `models` map — each carrying a real
// per-model `cost` block, so opencode's cost display matches what LiteLLM
// bills.
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
import type { LiteLLMModel, LiteLLMModelInfo } from './types.ts'
import {
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
  resolveApiKey,
} from './litellm-api.ts'
import { configModelFromProxy, enrichModel } from './build-config-model.ts'

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
 * Provider ids already warned about a dead price-table option, so a config
 * carrying one is mentioned once per process rather than on every `config`
 * invocation.
 */
const reportedStaleOptions = new Set<string>()

/** Clear the once-per-process report guard — used by tests. */
export function resetReportedStaleOptions(): void {
  reportedStaleOptions.clear()
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
  // Nothing is fetched here. Every URL the plugin talks to is per-provider
  // config (`options.baseURL`), and provider options do not exist until the
  // `config` hook runs — so both calls are made there, and awaited before any
  // model is injected. That hook is invoked exactly ONCE (measured under both
  // `serve` and the CLI), so there is no later pass to fill prices in on.

  // Every message goes to both sinks. console reaches whoever is attached to
  // the opencode server's stdout; client.app.log is the only path into
  // ~/.local/share/opencode/log/opencode.log, which is where anyone asking
  // "why does this model show $0?" after the fact will actually look.
  //
  // Fire-and-forget on purpose: client calls made from inside the `config`
  // hook are re-entrant — asking opencode itself for anything from in here is
  // what used to deadlock startup — so awaiting one risks stalling it. A failed log must never be able to break
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

        // Pricing used to come from a separately configured price table:
        // `options.catalogURL` (and `options.pricingURL` before 0.7.0). Both
        // are dead now that the proxy answers with its own numbers, and
        // neither is read. Say so rather than ignoring them silently: a config
        // still carrying one was written by someone who wanted pricing, and a
        // dead key is exactly what would make them think it is still doing the
        // work. Warned once per provider per process.
        const staleOption =
          typeof options.catalogURL === 'string' && options.catalogURL
            ? 'catalogURL'
            : typeof options.pricingURL === 'string' && options.pricingURL
              ? 'pricingURL'
              : undefined
        if (staleOption && !reportedStaleOptions.has(providerId)) {
          reportedStaleOptions.add(providerId)
          report(
            'warn',
            `[litellm-pricing] provider "${providerId}": options.${staleOption} is no longer read — ` +
              'pricing now comes from the proxy itself (/v1/model/info, LiteLLM v1.96.0+). ' +
              'Remove it.',
          )
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

          // What each model costs, what kind of model it is, and what it can
          // do. Best-effort by necessity: a proxy older than LiteLLM v1.96.0,
          // or a key scoped to exclude the route, refuses it. Every model is
          // still injected in that case — unpriced, and classified by the
          // `mode` on /v1/models if it carries one, else by the id heuristics.
          let infoByName: Map<string, LiteLLMModelInfo> | null = null
          try {
            infoByName = await discoverLiteLLMModelInfo(baseURL, apiKey, customHeaders)
          } catch {
            infoByName = null
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

            // /v1/model/info is keyed by model_name, which is exactly the id
            // /v1/models reports — no alias resolution needed.
            const info = infoByName?.get(model.id)
            const enriched = info ? enrichModel(model, info) : model
            const entry = configModelFromProxy(enriched, info)

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
          //
          // Counts only, on one short line. `hidden` folds every reason a
          // discovered model did not get injected: the per-reason breakdown and
          // the baseURL both read as problems on a run where nothing is wrong.
          // The URL is in the user's own config, and the discovery-failure
          // warning above already names the host that did not answer.
          //
          // Nothing priced at all is the systematic-failure shape, and the
          // cause is almost always the same one — so name it, with the version
          // that fixes it. A per-model gap (an unmapped base_model) shows up in
          // the `no pricing:` line below instead.
          const hidden = skipped + wildcards + preexisting + reinjected + malformed
          const nothingPriced = added > 0 && priced === 0
          report(
            nothingPriced ? 'warn' : 'info',
            `[litellm-pricing] ${providerId}: ${added} models, ${priced} priced, ${hidden} hidden` +
              (nothingPriced && !infoByName
                ? ' — /v1/model/info unreadable: needs LiteLLM v1.96.0+ and a key allowed to call it'
                : ''),
          )

          // Name them: a count alone doesn't say which model will read as free.
          // Capped so a large proxy stays readable — the summary line above
          // already carries the true priced/unpriced split.
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
        // (AbortSignal.timeout on both HTTP calls). A blanket timeout here only
        // ever hid an unbounded call while still charging the user its full
        // duration at startup.
        await work()
      }
    },
  }
}

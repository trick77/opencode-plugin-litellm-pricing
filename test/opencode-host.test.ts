// End-to-end scenarios: the plugin loaded the way opencode loads it, driven
// against a fake LiteLLM proxy. See test/helpers/fake-opencode-host.ts for
// what is faked and what that costs.
//
// Every scenario uses its OWN baseURL. `injectedModelIds` in src/plugin.ts is
// module-level state keyed by baseURL with no reset, so two scenarios sharing
// a URL would send the second one down the early-return path — passing
// without having injected anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '@opencode-ai/plugin'
import { resetCatalogCache } from '../src/catalog.ts'
import { resetReportedCatalog } from '../src/plugin.ts'
import {
  CATALOG_PROVIDERS,
  captureConsole,
  fakePluginInput,
  json,
  loadPlugins,
  withFakeProxy,
  type LoggedEntry,
  type Routes,
} from './helpers/fake-opencode-host.ts'

/** Load the entry module exactly as opencode would, and return the one plugin. */
async function loadTheOnePlugin() {
  const mod = await import('../src/index.ts')
  const plugins = loadPlugins(mod)
  assert.equal(plugins.length, 1, 'entry module should expose exactly one plugin')
  return plugins[0]!
}

/** Load, instantiate and run the `config` hook over `config`, capturing output. */
async function runConfigHook(
  config: Record<string, unknown>,
  routes: Routes,
  opts: {
    catalogProviders?: unknown[]
    catalogAll?: unknown[]
    noProviderList?: boolean
    logged?: LoggedEntry[]
    logFails?: boolean
    /** Run the hook once, before the catalog can land. */
    singlePass?: boolean
  } = {},
) {
  resetCatalogCache()
  resetReportedCatalog()
  const plugin = await loadTheOnePlugin()
  return captureConsole(() =>
    withFakeProxy(routes, async () => {
      const input = fakePluginInput(opts.catalogProviders ?? CATALOG_PROVIDERS, {
        logged: opts.logged,
        logFails: opts.logFails,
        all: opts.catalogAll,
        noProviderList: opts.noProviderList,
      })
      const hooks = await plugin(input)
      // Two passes, because that is what opencode does — and it is load-bearing
      // here: the catalog cannot resolve while the first pass is running (see
      // startCatalogLoad), so pass one injects bare and pass two prices. A
      // single-pass harness would assert against a state production never
      // settles in.
      await hooks.config?.(config as unknown as Config)
      if (!opts.singlePass) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await hooks.config?.(config as unknown as Config)
      }
      return config
    }),
  )
}

const PROVIDER_KEY = 'opencode-plugin-litellm-pricing'

/** A provider block shaped like the one the README tells users to write. */
function providerConfig(baseURL: string, extra: Record<string, unknown> = {}) {
  return {
    provider: {
      [PROVIDER_KEY]: {
        // `npm` deliberately omitted — the plugin should default it.
        options: { baseURL, apiKey: 'sk-test' },
        ...extra,
      } as Record<string, unknown>,
    },
  }
}

const CHAT_MODEL = { id: 'ai-gateway-gpt-5.4', object: 'model' }

function modelsResponse(...ids: Array<{ id: string; object: string }>) {
  return json({ object: 'list', data: ids })
}

// 1 — the loader contract. This is the regression test: 0.2.0 re-exported a
// Set from types.ts through src/index.ts, and opencode refused to load it.
test('the entry module satisfies opencode\'s plugin loader', async () => {
  const mod = await import('../src/index.ts')
  const nonFunctions = Object.entries(mod)
    .filter(([, v]) => typeof v !== 'function')
    .map(([k, v]) => `${k} (${typeof v})`)

  // Reported before the throw, because "Plugin export is not a function"
  // alone does not say WHICH export — the whole difficulty of the original bug.
  assert.deepEqual(
    nonFunctions,
    [],
    `non-function exports leak into the entry module: ${nonFunctions.join(', ')}`,
  )

  const plugins = loadPlugins(mod)
  assert.equal(plugins.length, 1)
  assert.equal(typeof plugins[0], 'function')
})

// 2 — the happy path, all the way through.
test('injects discovered models with catalog pricing into the config', async () => {
  const config = providerConfig('https://proxy-inject.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/model_group/info': () =>
      json({
        data: [
          {
            model_group: 'ai-gateway-gpt-5.4',
            mode: 'chat',
            max_input_tokens: 1050000,
            max_output_tokens: 128000,
            supports_function_calling: true,
          },
        ],
      }),
  })

  const provider = config.provider[PROVIDER_KEY]!
  assert.equal(provider.npm, '@ai-sdk/openai-compatible', 'npm should be defaulted')

  const models = provider.models as Record<string, Record<string, unknown>>
  const entry = models['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the chat model should be injected')
  assert.equal(entry.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  // Priced from the models.dev catalog by name-match, never from the proxy.
  // No cache_write: a zero cache tier is dropped rather than reported as free.
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
  assert.equal(entry.tool_call, true)

  assert.ok(
    logs.some((l) => l.includes('1 discovered, 1 added')) &&
      logs.some((l) => l.includes('catalog arrived late, priced 1/1')),
    `expected a summary and a late-pricing line, got: ${logs.join(' | ')}`,
  )
})

// 3 — LiteLLM's own `mode` filters non-chat models. The id here is
// deliberately neutral: a name like `…-text-embedding-3-small` would be
// filtered by the id heuristics too, which would not prove the mode path ran.
test('non-chat models are filtered out by /model_group/info mode', async () => {
  const config = providerConfig('https://proxy-mode.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL, { id: 'house-vectorizer', object: 'model' }),
    '/model_group/info': () =>
      json({
        data: [
          { model_group: 'ai-gateway-gpt-5.4', mode: 'chat' },
          { model_group: 'house-vectorizer', mode: 'embedding' },
        ],
      }),
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.ok(models['ai-gateway-gpt-5.4'], 'the chat model should survive')
  assert.equal(models['house-vectorizer'], undefined, 'the embedding model should be hidden')
  assert.ok(logs.some((l) => l.includes('1 non-chat hidden')))
})

// 3b — the rename compatibility guarantee. `provider` keys live in the user's
// opencode.json, so the pre-0.3.0 package name must keep matching; someone who
// only updates their `plugin` entry must not silently lose all pricing.
test('the pre-rename provider id is still matched', async () => {
  const config = {
    provider: {
      'opencode-litellm-pricing': {
        options: { baseURL: 'https://proxy-legacy-id.test/v1', apiKey: 'sk-test' },
      } as Record<string, unknown>,
    },
  }
  await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/model_group/info': () => json({ data: [{ model_group: 'ai-gateway-gpt-5.4', mode: 'chat' }] }),
  })

  const models = config.provider['opencode-litellm-pricing']!.models as Record<
    string,
    Record<string, unknown>
  >
  const entry = models?.['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the legacy provider id should still be enriched')
  // Pricing specifically — a matched-but-unpriced entry would be the silent
  // half-failure this guarantee exists to rule out.
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
})

// 3c — matching must not have become a free-for-all.
test('an unrelated provider id is left alone', async () => {
  const config = {
    provider: {
      anthropic: {
        options: { baseURL: 'https://proxy-unrelated.test/v1' },
      } as Record<string, unknown>,
    },
  }
  const { logs, warns } = await runConfigHook(config, {})

  assert.equal(config.provider.anthropic.models, undefined, 'must not touch a foreign provider')
  assert.deepEqual([...logs, ...warns], [], 'must say nothing about a provider it does not own')
})

// 4 — a matched provider with nothing to talk to.
test('a provider without options.baseURL warns and injects nothing', async () => {
  const config = { provider: { litellm: { options: {} } as Record<string, unknown> } }
  const { warns } = await runConfigHook(config, {})

  assert.equal(config.provider.litellm.models, undefined, 'nothing should be injected')
  assert.ok(
    warns.some((w) => w.includes('no options.baseURL')),
    `expected a baseURL warning, got: ${warns.join(' | ')}`,
  )
})

// 5 — an unreachable proxy must never break opencode's startup.
test('a proxy that cannot be reached is survivable', async () => {
  const config = providerConfig('https://proxy-down.test/v1')
  const { warns } = await runConfigHook(config, {
    '/v1/models': () => {
      throw new Error('ECONNREFUSED')
    },
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.deepEqual(models, {}, 'no models should be injected')
  assert.ok(
    warns.some((w) => w.includes('Model discovery failed')),
    `expected a discovery warning, got: ${warns.join(' | ')}`,
  )
})

// 6 — /model_group/info is best-effort: some keys are not allowed to call it.
test('discovery still works when /model_group/info is refused', async () => {
  const config = providerConfig('https://proxy-nogroups.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () =>
      modelsResponse(CHAT_MODEL, { id: 'ai-gateway-text-embedding-3-small', object: 'model' }),
    '/model_group/info': () => json({ error: 'forbidden' }, 403),
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.ok(models['ai-gateway-gpt-5.4'], 'the chat model should still be injected')
  // No `mode` available, so this one is caught by the id heuristics instead.
  assert.equal(models['ai-gateway-text-embedding-3-small'], undefined)
  assert.ok(
    logs.some((l) => l.includes('[no /model_group/info')),
    `expected the degraded-path marker, got: ${logs.join(' | ')}`,
  )
})

// 7 — the guarantee the README makes about hand-curated entries.
test('existing hand-curated model entries are never overwritten', async () => {
  const curated = { name: 'Hand Curated', cost: { input: 999, output: 999 } }
  const config = providerConfig('https://proxy-curated.test/v1', {
    models: { 'ai-gateway-gpt-5.4': curated },
  })
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/model_group/info': () => json({ data: [{ model_group: 'ai-gateway-gpt-5.4', mode: 'chat' }] }),
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.deepEqual(models['ai-gateway-gpt-5.4'], curated)
  // The entry surviving is not enough on its own — it would also survive if
  // discovery never ran. The summary line proves the model WAS discovered and
  // then deliberately skipped.
  assert.ok(
    logs.some((l) => l.includes('1 discovered, 0 added') && l.includes('1 already present')),
    `expected discovery to have run and added nothing, got: ${logs.join(' | ')}`,
  )
})

// --- startup reporting ------------------------------------------------------
//
// A summary that only ever prints an absolute "N with pricing" can't be read:
// it says nothing about how many models LiteLLM actually offered, and a run
// that prices nothing looks the same as a run with nothing to price. These
// scenarios pin the numbers and the sinks.

/** Three chat models plus one non-chat and one wildcard — nothing is priced. */
const MIXED_MODELS = [
  { id: 'ai-gateway-gpt-5.4', object: 'model' },
  { id: 'some-unknown-llama-thing', object: 'model' },
  { id: 'text-embedding-3-large', object: 'model' },
  { id: 'deepseek/*', object: 'model' },
]

test('the summary accounts for every discovered model, and names the unpriced', async () => {
  const baseURL = 'https://proxy-summary.test'
  const { logs, warns } = await runConfigHook(providerConfig(baseURL), {
    '/v1/models': () => json({ data: MIXED_MODELS }),
    '/model_group/info': () => json({ data: [] }),
  })
  const all = [...logs, ...warns]

  // 4 discovered = 2 added + 1 non-chat + 1 wildcard, and of the 2 added only
  // ai-gateway-gpt-5.4 has a catalog match.
  assert.ok(
    all.some((l) => l.includes('4 discovered, 2 added')),
    `expected an accounted summary, got: ${all.join(' | ')}`,
  )
  assert.ok(
    all.some((l) => l.includes('catalog arrived late, priced 1/2')),
    `expected the late-pricing count, got: ${all.join(' | ')}`,
  )
  assert.ok(
    all.some((l) => l.includes('1 non-chat hidden') && l.includes('1 wildcard ignored')),
    `expected the non-chat and wildcard clauses, got: ${all.join(' | ')}`,
  )
})

test('the first pass injects bare rather than blocking on the catalog', async () => {
  const baseURL = 'https://proxy-firstpass.test'
  // The catalog call cannot be answered while this pass is running, so the
  // models must land unpriced rather than the pass stalling or dropping them.
  const { result, logs } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: MIXED_MODELS }),
      '/model_group/info': () => json({ data: [] }),
    },
    { singlePass: true },
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  assert.ok(models['ai-gateway-gpt-5.4'], 'the model must be in the picker even unpriced')
  assert.equal((models['ai-gateway-gpt-5.4'] as Record<string, unknown>).cost, undefined)
  // "pending" and "missing" must not read the same: warning here would cry
  // wolf on every normal startup.
  assert.ok(
    logs.some((l) => l.includes('pricing pending')),
    `expected a pending summary, got: ${logs.join(' | ')}`,
  )
})

test('models unpriced by a loaded catalog are named', async () => {
  const baseURL = 'https://proxy-unpriced.test'
  // Third pass: by now the catalog is loaded, so discovery re-runs against it
  // and the count alone doesn't say WHICH model reads as free.
  const { warns, logs } = await runConfigHook(providerConfig(baseURL), {
    '/v1/models': () => json({ data: MIXED_MODELS }),
    '/model_group/info': () => json({ data: [] }),
  })
  const all = [...logs, ...warns]
  assert.ok(
    all.some((l) => l.includes('catalog arrived late, priced 1/2')),
    `expected 1 of 2 priced late, got: ${all.join(' | ')}`,
  )
})

test('every reported line is also written to opencode own log', async () => {
  const baseURL = 'https://proxy-applog.test'
  const logged: LoggedEntry[] = []
  const { logs, warns } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: MIXED_MODELS }),
      '/model_group/info': () => json({ data: [] }),
    },
    { logged },
  )

  // console alone never reaches ~/.local/share/opencode/log/opencode.log, so
  // the summary would be unretrievable after the fact.
  assert.ok(logged.length > 0, 'expected app.log to have been written')
  assert.ok(logged.every((e) => e.service === 'litellm-pricing'))
  for (const line of [...logs, ...warns]) {
    assert.ok(
      logged.some((e) => e.message === line),
      `console line was not mirrored to app.log: ${line}`,
    )
  }
})

test('a failing app.log never breaks config loading', async () => {
  const baseURL = 'https://proxy-logfail.test'
  const { result } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: MIXED_MODELS }),
      '/model_group/info': () => json({ data: [] }),
    },
    { logFails: true },
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  assert.ok(models['ai-gateway-gpt-5.4'], 'models must still be injected when logging fails')
})

test('an unavailable catalog is reported, not swallowed into silent $0', async () => {
  const baseURL = 'https://proxy-nocatalog.test'
  // A provider list with no azure/openai entry — the shape a catalog load
  // failure and an unusable response both collapse to today.
  const { logs, warns } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: MIXED_MODELS }),
      '/model_group/info': () => json({ data: [] }),
    },
    { catalogProviders: [{ id: 'some-aggregator', models: {} }] },
  )
  const all = [...logs, ...warns]

  assert.ok(
    warns.some((l) => l.includes('no priceable providers')),
    `expected a catalog warning, got: ${all.join(' | ')}`,
  )
  // And the summary must warn too: added > 0 with priced === 0 is the
  // systematic-failure shape, not an informational result.
  // And nothing is repriced later, because there is no catalog to reprice
  // from — the warning above is the only explanation the user will get.
  assert.ok(
    !all.some((l) => l.includes('catalog arrived late')),
    `expected no late pricing without a catalog, got: ${all.join(' | ')}`,
  )
})

test('a working catalog reports its size and source', async () => {
  const baseURL = 'https://proxy-catalogok.test'
  const { logs } = await runConfigHook(providerConfig(baseURL), {
    '/v1/models': () => json({ data: MIXED_MODELS }),
    '/model_group/info': () => json({ data: [] }),
  })

  // This line is what separates "the catalog never loaded" from "the catalog
  // loaded and nothing matched" — the two causes of a clean zero.
  assert.ok(
    logs.some((l) => l.includes('catalog:') && l.includes('provider.list')),
    `expected a catalog line, got: ${logs.join(' | ')}`,
  )
})

test('prices from /provider, not from the reader own configured providers', async () => {
  const baseURL = 'https://proxy-source.test'
  // What config.providers returns on a machine with no Azure credentials: the
  // user's own `openai`, which reports every cost as 0. Sourcing prices from
  // it would price a real model at $0 by accident of the reader's config.
  const CONFIGURED = [
    {
      id: 'openai',
      models: {
        'gpt-5.4': {
          id: 'gpt-5.4',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 1, output: 1 },
          capabilities: { input: {} },
        },
      },
    },
  ]
  const { result } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: [{ id: 'ai-gateway-gpt-5.4', object: 'model' }] }),
      '/model_group/info': () => json({ data: [] }),
    },
    { catalogProviders: CONFIGURED, catalogAll: CATALOG_PROVIDERS },
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  const entry = models['ai-gateway-gpt-5.4'] as Record<string, unknown>
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
  // Context size and the other model parameters ride along on the same match.
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  assert.equal(entry.tool_call, true)
  assert.equal(entry.reasoning, true)
})

test('falls back to config.providers when /provider is missing', async () => {
  const baseURL = 'https://proxy-fallback.test'
  const { result, logs } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: [{ id: 'ai-gateway-gpt-5.4', object: 'model' }] }),
      '/model_group/info': () => json({ data: [] }),
    },
    { noProviderList: true },
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  assert.ok((models['ai-gateway-gpt-5.4'] as Record<string, unknown>).cost, 'still priced')
  assert.ok(
    logs.some((l) => l.includes('config.providers')),
    `expected the fallback source named, got: ${logs.join(' | ')}`,
  )
})

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
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@opencode-ai/plugin'
import {
  DEFAULT_PRICE_TABLE_URL,
  resetCatalogCache,
  settleRefreshForTests,
} from '../src/catalog.ts'
import { resetReportedCatalog } from '../src/plugin.ts'
import {
  DEFAULT_PRICE_TABLE_PATHNAME,
  PRICE_TABLE,
  captureConsole,
  fetchedURLs,
  seedCache,
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
    logged?: LoggedEntry[]
    logFails?: boolean
    /**
     * Put a cache on disk before the run, so a cache branch is exercised. The
     * cache is keyed by price-table URL, so `url` has to be the one the
     * scenario's provider will actually resolve — the default otherwise.
     */
    seed?: { url?: string; table: unknown; ageMs: number; v?: number }
  } = {},
) {
  resetCatalogCache()
  resetReportedCatalog()
  // The catalog is cached on disk between runs. Point that at a throwaway dir
  // so the suite can neither read the developer's cache nor write to it —
  // otherwise these scenarios pass or fail depending on the host machine.
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'litellm-pricing-test-'))
  if (opts.seed) {
    await seedCache(
      opts.seed.url ?? DEFAULT_PRICE_TABLE_URL,
      opts.seed.table,
      opts.seed.ageMs,
      opts.seed.v,
    )
  }
  const plugin = await loadTheOnePlugin()
  const captured = await captureConsole(() =>
    withFakeProxy(routes, async () => {
      const input = fakePluginInput(opts.catalogProviders ?? [], {
        logged: opts.logged,
        logFails: opts.logFails,
      })
      // Once, because that is what opencode does — measured under both
      // `opencode serve` and the CLI. There is no second pass to fall back on,
      // which is why the price table has to be loaded before the hook runs.
      const hooks = await plugin(input)
      await hooks.config?.(config as unknown as Config)
      return config
    }),
  )
  // Settle any background refresh before the next scenario swaps
  // XDG_CACHE_HOME out from under it — otherwise its cache write lands in the
  // NEXT scenario's directory and quietly turns a no-table branch into a
  // cache hit.
  await settleRefreshForTests()
  return captured
}

const PROVIDER_KEY = 'opencode-plugin-litellm-pricing'

const ONE_HOUR = 60 * 60 * 1000
const EIGHT_DAYS = 8 * 24 * ONE_HOUR

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
  const { logs } = await runConfigHook(
    config,
    {
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
    },
    // Priced from a seeded cache: nothing ships in the package, so the cache
    // is the only thing that can price a start.
    { seed: { table: PRICE_TABLE, ageMs: ONE_HOUR } },
  )

  const provider = config.provider[PROVIDER_KEY]!
  assert.equal(provider.npm, '@ai-sdk/openai-compatible', 'npm should be defaulted')

  const models = provider.models as Record<string, Record<string, unknown>>
  const entry = models['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the chat model should be injected')
  assert.equal(entry.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  // Priced from the price table by name-match, never from the proxy. No
  // cache_write: the table states none, and an absent tier is omitted rather
  // than reported as free.
  assert.deepEqual(entry.cost, {
    input: 2.5,
    output: 15,
    cache_read: 0.25,
    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
  })
  assert.equal(entry.tool_call, true)

  assert.ok(
    logs.some((l) => l.includes('1 discovered, 1 added, pricing for 1/1')),
    `expected a priced summary, got: ${logs.join(' | ')}`,
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
  await runConfigHook(
    config,
    {
      '/v1/models': () => modelsResponse(CHAT_MODEL),
      '/model_group/info': () =>
        json({ data: [{ model_group: 'ai-gateway-gpt-5.4', mode: 'chat' }] }),
    },
    { seed: { table: PRICE_TABLE, ageMs: ONE_HOUR } },
  )

  const models = config.provider['opencode-litellm-pricing']!.models as Record<
    string,
    Record<string, unknown>
  >
  const entry = models?.['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the legacy provider id should still be enriched')
  // Pricing specifically — a matched-but-unpriced entry would be the silent
  // half-failure this guarantee exists to rule out.
  assert.deepEqual(entry.cost, {
    input: 2.5,
    output: 15,
    cache_read: 0.25,
    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
  })
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
    all.some((l) => l.includes('no pricing: some-unknown-llama-thing')),
    `expected the unpriced model named, got: ${all.join(' | ')}`,
  )
  assert.ok(
    all.some((l) => l.includes('1 non-chat hidden') && l.includes('1 wildcard ignored')),
    `expected the non-chat and wildcard clauses, got: ${all.join(' | ')}`,
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

test('with no table at all, the failure is reported rather than shown as $0', async () => {
  const baseURL = 'https://proxy-nocatalog.test'
  // The fresh-install path: no cache, nothing shipped, and no fetch anybody
  // waits on. It has to EXPLAIN a priceless startup — an unexplained $0 is
  // what started all of this.
  const { logs, warns } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: MIXED_MODELS }),
      '/model_group/info': () => json({ data: [] }),
      // A table with nothing usable in it: parses, prices nothing.
      [DEFAULT_PRICE_TABLE_PATHNAME]: () => json({ sample_spec: { litellm_provider: 'none' } }),
    },
  )
  const all = [...logs, ...warns]

  assert.ok(
    warns.some((l) => l.includes('catalog unavailable')),
    `expected a catalog warning, got: ${all.join(' | ')}`,
  )
  // added > 0 with priced === 0 is the systematic-failure shape, so it warns.
  assert.ok(
    warns.some((l) => l.includes('pricing for 0/2')),
    `expected the zero-coverage summary to warn, got: ${all.join(' | ')}`,
  )
})

test('a working catalog reports its size and source', async () => {
  const baseURL = 'https://proxy-catalogok.test'
  const { logs } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: MIXED_MODELS }),
      '/model_group/info': () => json({ data: [] }),
    },
    { seed: { table: PRICE_TABLE, ageMs: ONE_HOUR } },
  )

  // This line separates "no table loaded" from "table loaded, nothing matched"
  // — the two causes of a clean zero — and names WHICH source answered, since
  // that is what explains a stale start.
  assert.ok(
    logs.some((l) => l.includes('catalog:') && l.includes('model(s) from cache')),
    `expected a catalog line naming the source, got: ${logs.join(' | ')}`,
  )
})

// --- where the price table comes from ---------------------------------------
//
// load() answers from the on-disk cache once there is one, and only the very
// first start waits on the network. Each branch is pinned by its source
// string: a mis-wired cache still prices correctly (by fetching every time)
// while having silently stopped caching, so asserting "it was priced" proves
// nothing.

/** A cached table, in the trimmed flat shape writeCache stores. */
const CACHED_TABLE = {
  'azure/gpt-5.4': {
    litellm_provider: 'azure',
    max_input_tokens: 10,
    max_output_tokens: 20,
    input_cost_per_token: 0.00000111,
    output_cost_per_token: 0.00000222,
  },
}

const PROXY_ROUTES = {
  '/v1/models': () => json({ data: [{ id: 'ai-gateway-gpt-5.4', object: 'model' }] }),
  '/model_group/info': () => json({ data: [] }),
}

function costOf(result: Record<string, unknown>): unknown {
  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  return (models['ai-gateway-gpt-5.4'] as Record<string, unknown>).cost
}

test('a fresh cache answers, without touching the network', async () => {
  const { result, logs } = await runConfigHook(
    providerConfig('https://proxy-fresh.test'),
    {
      ...PROXY_ROUTES,
      // Reaching the price table at all on this path is the failure.
      [DEFAULT_PRICE_TABLE_PATHNAME]: () => {
        throw new Error('should not fetch when the cache is fresh')
      },
    },
    { seed: { table: CACHED_TABLE, ageMs: ONE_HOUR } },
  )

  assert.deepEqual(costOf(result), { input: 1.11, output: 2.22 })
  assert.ok(
    logs.some((l) => l.includes('catalog:') && l.includes('from cache')),
    `expected the cache named as source, got: ${logs.join(' | ')}`,
  )
  // Asserted, not merely arranged: the throwing route above proves nothing on
  // its own, because a background refresh swallows whatever it throws.
  assert.deepEqual(
    fetchedURLs.filter((u) => u.includes(DEFAULT_PRICE_TABLE_PATHNAME)),
    [],
    'a fresh cache must not reach the price table at all',
  )
})

test('a stale cache still answers immediately, refreshing behind it', async () => {
  // Week-old list prices beat making someone wait. Before this, a stale cache
  // was only consulted AFTER the fetch had already failed — so a slow network
  // stalled startup even though a perfectly usable table sat on disk.
  const { result, logs } = await runConfigHook(
    providerConfig('https://proxy-stale.test'),
    PROXY_ROUTES,
    { seed: { table: CACHED_TABLE, ageMs: EIGHT_DAYS } },
  )

  assert.deepEqual(costOf(result), { input: 1.11, output: 2.22 })
  assert.ok(
    logs.some((l) => l.includes('stale cache (refreshing)')),
    `expected the stale-cache source, got: ${logs.join(' | ')}`,
  )
})

test('a cache written by an older schema is discarded, not half-read', async () => {
  // The cache holds a TRIMMED table, so its layout is tied to the fields
  // toCatalogFields and buildCost read. Serving an old layout would quietly
  // price nothing from a newly read field.
  const { logs } = await runConfigHook(
    providerConfig('https://proxy-schema.test'),
    { ...PROXY_ROUTES, [DEFAULT_PRICE_TABLE_PATHNAME]: () => json(PRICE_TABLE) },
    { seed: { table: CACHED_TABLE, ageMs: ONE_HOUR, v: 0 } },
  )

  // Asserting on the SOURCE, not on "it was priced": the fetch prices this
  // correctly either way, hiding a cache that had stopped being read.
  assert.ok(
    !logs.some((l) => l.includes('from cache')),
    `expected the stale-schema cache to be discarded, got: ${logs.join(' | ')}`,
  )
  assert.ok(
    logs.some((l) => l.includes('catalog:') && l.includes(DEFAULT_PRICE_TABLE_URL)),
    `expected the fetched table as source, got: ${logs.join(' | ')}`,
  )
})

test('prices from the fetched price table, including the model parameters', async () => {
  const baseURL = 'https://proxy-source.test'
  const { result } = await runConfigHook(
    providerConfig(baseURL),
    {
      '/v1/models': () => json({ data: [{ id: 'ai-gateway-gpt-5.4', object: 'model' }] }),
      '/model_group/info': () => json({ data: [] }),
      [DEFAULT_PRICE_TABLE_PATHNAME]: () => json(PRICE_TABLE),
    },
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  const entry = models['ai-gateway-gpt-5.4'] as Record<string, unknown>
  assert.deepEqual(entry.cost, {
    input: 2.5,
    output: 15,
    cache_read: 0.25,
    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
  })
  // Context size and the other model parameters ride along on the same match.
  assert.deepEqual(entry.limit, { context: 922000, output: 128000 })
  assert.equal(entry.tool_call, true)
  assert.equal(entry.reasoning, true)
  assert.equal(entry.attachment, true)
  assert.deepEqual(entry.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] })
})

test('a price-table outage costs nothing once a cache exists', async () => {
  const baseURL = 'https://proxy-outage.test'
  // The outage that matters is the everyday one: a table on disk, however old,
  // and no network. Week-old list prices beat both a stall and a $0.
  const { result, logs, warns } = await runConfigHook(
    providerConfig(baseURL),
    {
      ...PROXY_ROUTES,
      [DEFAULT_PRICE_TABLE_PATHNAME]: () => {
        throw new Error('network down')
      },
    },
    { seed: { table: PRICE_TABLE, ageMs: EIGHT_DAYS } },
  )

  assert.deepEqual(costOf(result), {
    input: 2.5,
    output: 15,
    cache_read: 0.25,
    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
  })
  assert.ok(
    logs.some((l) => l.includes('stale cache (refreshing)')),
    `expected the stale-cache source, got: ${logs.join(' | ')}`,
  )
  // Nothing is wrong here, so nothing may warn.
  assert.equal(warns.length, 0, `expected no warnings, got: ${warns.join(' | ')}`)
})

// --- options.pricingURL -----------------------------------------------------
//
// The whole point of the option: a proxy operator serves an enriched copy of
// LiteLLM's table, carrying their own gateway model names, and those price by
// exact key instead of by substring against the public model line.

const CUSTOM_PRICING_URL = 'https://catalog.example.com/model_prices_and_context_window.json'
const CUSTOM_PRICING_PATHNAME = '/model_prices_and_context_window.json'

/** An enriched table: the gateway's own model name, priced directly. */
const ENRICHED_TABLE = {
  'ai-gateway-gpt-5.4': {
    litellm_provider: 'ai-gateway',
    max_input_tokens: 400000,
    max_output_tokens: 100000,
    input_cost_per_token: 0.00000333,
    output_cost_per_token: 0.00000444,
  },
}

/** Read back what the plugin cached for `url` — the mirror of `seedCache`. */
async function readCacheFile(url: string): Promise<{ table: Record<string, unknown> }> {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 12)
  const file = join(
    process.env.XDG_CACHE_HOME!,
    'opencode-plugin-litellm-pricing',
    `price-table-${key}.json`,
  )
  return JSON.parse(await readFile(file, 'utf8')) as { table: Record<string, unknown> }
}

test('options.pricingURL is fetched instead of the default table', async () => {
  const { result, logs } = await runConfigHook(
    providerConfig('https://proxy-custom.test', {
      options: { baseURL: 'https://proxy-custom.test', apiKey: 'sk-test', pricingURL: CUSTOM_PRICING_URL },
    }),
    {
      ...PROXY_ROUTES,
      [CUSTOM_PRICING_PATHNAME]: () => json(ENRICHED_TABLE),
      // The default table must not be consulted at all once a URL is set.
      [DEFAULT_PRICE_TABLE_PATHNAME]: () => {
        throw new Error('the default table must not be fetched when pricingURL is set')
      },
    },
  )

  // The exact key wins: $3.33/$4.44, not whatever gpt-5.4 costs upstream.
  assert.deepEqual(costOf(result), { input: 3.33, output: 4.44 })

  // And it survives the round-trip through the cache. `trim` must filter by
  // FIELD only: a provider filter there (the shape the old models.dev table
  // needed) would drop every enriched entry on the way to disk, and the next
  // start would price nothing while every assertion above still passed.
  const cached = await readCacheFile(CUSTOM_PRICING_URL)
  assert.deepEqual(cached.table['ai-gateway-gpt-5.4'], {
    litellm_provider: 'ai-gateway',
    max_input_tokens: 400000,
    max_output_tokens: 100000,
    input_cost_per_token: 0.00000333,
    output_cost_per_token: 0.00000444,
  })
  // The configured URL is named as the source, and — since this table carries
  // no azure/openai entries — the log says the substring pass is inert rather
  // than trailing off after "substring match via ". That is exactly the state
  // a partial table puts a user in, and it explains their coverage gap.
  assert.ok(
    logs.some((l) => l.includes(CUSTOM_PRICING_URL) && l.includes('exact model names only')),
    `expected the configured URL and an empty-provider note, got: ${logs.join(' | ')}`,
  )
  assert.deepEqual(
    fetchedURLs.filter((u) => u.includes(DEFAULT_PRICE_TABLE_PATHNAME)),
    [],
    'the default table must not be fetched when pricingURL is set',
  )
})

test('the cache is keyed per price-table URL', async () => {
  // A cache seeded for the DEFAULT url must never answer for a provider
  // configured with a different one — otherwise switching tables, or running
  // two providers against two tables, silently serves the wrong prices.
  const { result } = await runConfigHook(
    providerConfig('https://proxy-cachekey.test', {
      options: {
        baseURL: 'https://proxy-cachekey.test',
        apiKey: 'sk-test',
        pricingURL: CUSTOM_PRICING_URL,
      },
    }),
    { ...PROXY_ROUTES, [CUSTOM_PRICING_PATHNAME]: () => json(ENRICHED_TABLE) },
    { seed: { table: CACHED_TABLE, ageMs: ONE_HOUR } },
  )

  // $1.11/$2.22 is the other URL's cache. Seeing it here means the cache key
  // ignored the URL.
  assert.deepEqual(costOf(result), { input: 3.33, output: 4.44 })
})

test('an SDK without client.app.log does not lose every model', async () => {
  const baseURL = 'https://proxy-nolog.test'
  // Older opencode builds have no /log endpoint. The property access throws
  // synchronously, which `.catch()` cannot see — and an escaped throw here
  // takes the whole config hook down with it.
  resetCatalogCache()
  resetReportedCatalog()
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'litellm-pricing-test-'))
  const plugin = await loadTheOnePlugin()
  const config = providerConfig(baseURL)
  const { result } = await captureConsole(() =>
    withFakeProxy(
      {
        '/v1/models': () => json({ data: [{ id: 'ai-gateway-gpt-5.4', object: 'model' }] }),
        '/model_group/info': () => json({ data: [] }),
      },
      async () => {
        const input = fakePluginInput([])
        delete (input.client as unknown as Record<string, unknown>).app
        const hooks = await plugin(input)
        await hooks.config?.(config as unknown as Config)
        return config
      },
    ),
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  assert.ok(models['ai-gateway-gpt-5.4'], 'the model must survive an unloggable host')
})

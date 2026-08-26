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
import { resetReportedStaleOptions } from '../src/plugin.ts'
import {
  captureConsole,
  fetchedURLs,
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
    hostProviders?: unknown[]
    logged?: LoggedEntry[]
    logFails?: boolean
    /**
     * Extra `config` invocations, run after the first. Each callback prepares
     * the config for the pass that follows it. opencode calls the hook once,
     * but the plugin's re-entry bookkeeping only shows up across passes.
     */
    rerun?: Array<() => void>
  } = {},
) {
  resetReportedStaleOptions()
  const plugin = await loadTheOnePlugin()
  return captureConsole(() =>
    withFakeProxy(routes, async () => {
      const input = fakePluginInput(opts.hostProviders ?? [], {
        logged: opts.logged,
        logFails: opts.logFails,
      })
      // Once, because that is what opencode does — measured under both
      // `opencode serve` and the CLI. There is no second pass to fall back on,
      // which is why both proxy calls are awaited inside this one.
      const hooks = await plugin(input)
      await hooks.config?.(config as unknown as Config)
      for (const prepare of opts.rerun ?? []) {
        prepare()
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

function modelsResponse(...ids: Array<Record<string, unknown>>) {
  return json({ object: 'list', data: ids })
}

/** The priced info block the scenarios below expect to see come back out. */
const GPT_54_INFO = {
  mode: 'chat',
  max_input_tokens: 1050000,
  max_output_tokens: 128000,
  input_cost_per_token: 0.0000025,
  output_cost_per_token: 0.000015,
  cache_read_input_token_cost: 0.00000025,
  input_cost_per_token_above_200k_tokens: 0.000005,
  output_cost_per_token_above_200k_tokens: 0.0000225,
  cache_read_input_token_cost_above_200k_tokens: 0.0000005,
  supports_function_calling: true,
}

const GPT_54_COST = {
  input: 2.5,
  output: 15,
  cache_read: 0.25,
  context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
}

/** A /v1/model/info route serving one row per (name, info) pair. */
function modelInfoRoute(...rows: Array<[string, Record<string, unknown>]>) {
  return () => json({ data: rows.map(([model_name, model_info]) => ({ model_name, model_info })) })
}

const PROXY_ROUTES: Routes = {
  '/v1/models': () => modelsResponse(CHAT_MODEL),
  '/v1/model/info': modelInfoRoute(['ai-gateway-gpt-5.4', GPT_54_INFO]),
}

function costOf(result: Record<string, unknown>, id = 'ai-gateway-gpt-5.4'): unknown {
  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  return (models[id] as Record<string, unknown>).cost
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
test('injects discovered models with proxy pricing into the config', async () => {
  const config = providerConfig('https://proxy-inject.test/v1')
  const { logs } = await runConfigHook(config, PROXY_ROUTES)

  const provider = config.provider[PROVIDER_KEY]!
  assert.equal(provider.npm, '@ai-sdk/openai-compatible', 'npm should be defaulted')

  const models = provider.models as Record<string, Record<string, unknown>>
  const entry = models['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the chat model should be injected')
  assert.equal(entry.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  // Priced from LiteLLM's own resolved numbers. No cache_write: the proxy
  // states none, and an absent tier is omitted rather than reported as free.
  assert.deepEqual(entry.cost, GPT_54_COST)
  assert.equal(entry.tool_call, true)

  assert.ok(
    logs.some((l) => l.includes('1 models, 1 priced, 0 hidden')),
    `expected a priced summary, got: ${logs.join(' | ')}`,
  )
})

// 2b — the endpoint contract. /v2/model/info is the Admin UI listing and still
// needs an elevated key, so calling it would 403 exactly the keys this plugin
// is built for. Nothing outside the configured proxy may be fetched either.
test('only /v1/models and /v1/model/info are ever fetched', async () => {
  await runConfigHook(providerConfig('https://proxy-endpoints.test/v1'), PROXY_ROUTES)

  assert.deepEqual(
    fetchedURLs,
    ['https://proxy-endpoints.test/v1/models', 'https://proxy-endpoints.test/v1/model/info'],
    'the plugin must talk to the configured proxy and nothing else',
  )
})

// 3 — LiteLLM's own `mode` filters non-chat models. The id here is
// deliberately neutral: a name like `…-text-embedding-3-small` would be
// filtered by the id heuristics too, which would not prove the mode path ran.
test('non-chat models are filtered out by /v1/model/info mode', async () => {
  const config = providerConfig('https://proxy-mode.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL, { id: 'house-vectorizer', object: 'model' }),
    '/v1/model/info': modelInfoRoute(
      ['ai-gateway-gpt-5.4', GPT_54_INFO],
      ['house-vectorizer', { mode: 'embedding' }],
    ),
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.ok(models['ai-gateway-gpt-5.4'], 'the chat model should survive')
  assert.equal(models['house-vectorizer'], undefined, 'the embedding model should be hidden')
  assert.ok(logs.some((l) => l.includes('1 models, 1 priced, 1 hidden')))
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
  await runConfigHook(config, PROXY_ROUTES)

  const models = config.provider['opencode-litellm-pricing']!.models as Record<
    string,
    Record<string, unknown>
  >
  const entry = models?.['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the legacy provider id should still be enriched')
  // Pricing specifically — a matched-but-unpriced entry would be the silent
  // half-failure this guarantee exists to rule out.
  assert.deepEqual(entry.cost, GPT_54_COST)
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

// 6 — /v1/model/info is best-effort: a proxy older than LiteLLM v1.96.0, or a
// key scoped to exclude the route, refuses it. Losing pricing must not cost
// the models themselves.
test('discovery still works when /v1/model/info is refused', async () => {
  const config = providerConfig('https://proxy-noinfo.test/v1')
  const { logs, warns } = await runConfigHook(config, {
    '/v1/models': () =>
      modelsResponse(CHAT_MODEL, { id: 'ai-gateway-text-embedding-3-small', object: 'model' }),
    '/v1/model/info': () => json({ error: 'forbidden' }, 403),
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, Record<string, unknown>>
  const entry = models['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the chat model should still be injected')
  assert.equal(entry.cost, undefined, 'no info block means no cost, never a guessed one')
  // No `mode` available, so this one is caught by the id heuristics instead.
  assert.equal(models['ai-gateway-text-embedding-3-small'], undefined)

  // Nothing priced at all is the systematic-failure shape, so it warns — and
  // names the cause, because "0 priced" alone sends people looking at their
  // model config rather than at their LiteLLM version.
  const summary = warns.find((l) => l.includes('1 models, 0 priced, 1 hidden'))
  assert.ok(summary, `expected the zero-coverage summary to warn, got: ${warns.join(' | ')}`)
  assert.ok(
    summary.includes('v1.96.0'),
    `the summary should name the version that fixes it: ${summary}`,
  )
  // And the unpriced model is named, so the gap is diagnosable from the log.
  assert.ok(
    logs.some((l) => l.includes('no pricing: ai-gateway-gpt-5.4')),
    `expected the unpriced model named, got: ${logs.join(' | ')}`,
  )
})

// 6b — current LiteLLM emits `mode` on /v1/models itself, so a key that cannot
// read /v1/model/info loses pricing but keeps the non-chat filter — including
// for the models no id heuristic can name.
test('the mode on /v1/models still filters when /v1/model/info is refused', async () => {
  const config = providerConfig('https://proxy-modeonly.test/v1')
  const { warns } = await runConfigHook(config, {
    '/v1/models': () =>
      modelsResponse(
        { ...CHAT_MODEL, mode: 'chat' },
        { id: 'ai-gateway-veo-3.1', object: 'model', mode: 'video_generation' },
      ),
    '/v1/model/info': () => json({ error: 'forbidden' }, 403),
  })

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.ok(models['ai-gateway-gpt-5.4'], 'the chat model should still be injected')
  // Nothing in `veo` says "video" to the id heuristics. Only `mode` knows.
  assert.equal(
    models['ai-gateway-veo-3.1'],
    undefined,
    'the video generator should have been filtered out by its mode',
  )
  // Nothing priced (no info block), so the summary warns — but it still has to
  // account for the model it hid.
  assert.ok(
    warns.some((l) => l.includes('1 models, 0 priced, 1 hidden')),
    `expected the hidden model counted, got: ${warns.join(' | ')}`,
  )
})

// 6c — the multi-deployment case, end to end. LiteLLM resolves cost per
// deployment, so a group whose first row has no base_model mapping and whose
// second one does must be priced from the second.
test('a model group listed twice is priced from the deployment that resolved', async () => {
  const config = providerConfig('https://proxy-dupes.test/v1')
  const { result } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/v1/model/info': modelInfoRoute(
      ['ai-gateway-gpt-5.4', { mode: 'chat' }],
      ['ai-gateway-gpt-5.4', GPT_54_INFO],
    ),
  })

  assert.deepEqual(costOf(result), GPT_54_COST)
})

// 7 — the guarantee the README makes about hand-curated entries.
test('existing hand-curated model entries are never overwritten', async () => {
  const curated = { name: 'Hand Curated', cost: { input: 999, output: 999 } }
  const config = providerConfig('https://proxy-curated.test/v1', {
    models: { 'ai-gateway-gpt-5.4': curated },
  })
  const { logs } = await runConfigHook(config, PROXY_ROUTES)

  const models = config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  assert.deepEqual(models['ai-gateway-gpt-5.4'], curated)
  // The entry surviving is not enough on its own — it would also survive if
  // discovery never ran. The summary line proves the model WAS discovered and
  // then deliberately skipped.
  assert.ok(
    logs.some((l) => l.includes('0 models, 0 priced, 1 hidden')),
    `expected discovery to have run and added nothing, got: ${logs.join(' | ')}`,
  )
})

// --- startup reporting ------------------------------------------------------
//
// A summary that only ever prints an absolute "N with pricing" can't be read:
// it says nothing about how many models LiteLLM actually offered, and a run
// that prices nothing looks the same as a run with nothing to price. These
// scenarios pin the numbers and the sinks.

/** Three chat models plus one non-chat and one wildcard. */
const MIXED_MODELS = [
  { id: 'ai-gateway-gpt-5.4', object: 'model' },
  { id: 'some-unknown-llama-thing', object: 'model' },
  { id: 'text-embedding-3-large', object: 'model' },
  { id: 'deepseek/*', object: 'model' },
]

/** Only one of the two injectable models above has resolved costs. */
const MIXED_ROUTES: Routes = {
  '/v1/models': () => json({ data: MIXED_MODELS }),
  '/v1/model/info': modelInfoRoute(
    ['ai-gateway-gpt-5.4', GPT_54_INFO],
    ['some-unknown-llama-thing', { mode: 'chat' }],
    ['text-embedding-3-large', { mode: 'embedding' }],
  ),
}

test('the summary accounts for every discovered model, and names the unpriced', async () => {
  const { logs, warns } = await runConfigHook(
    providerConfig('https://proxy-summary.test'),
    MIXED_ROUTES,
  )
  const all = [...logs, ...warns]

  // 4 discovered = 2 added + 1 non-chat + 1 wildcard, and of the 2 added only
  // ai-gateway-gpt-5.4 has resolved costs. Both non-added reasons fold into
  // `hidden`, so the counts still add up to everything discovered.
  assert.ok(
    all.some((l) => l.includes('2 models, 1 priced, 2 hidden')),
    `expected an accounted summary, got: ${all.join(' | ')}`,
  )
  assert.ok(
    all.some((l) => l.includes('no pricing: some-unknown-llama-thing')),
    `expected the unpriced model named, got: ${all.join(' | ')}`,
  )
  // A per-model gap is not a systematic failure: something priced, so the
  // version hint would be wrong here.
  assert.ok(
    !all.some((l) => l.includes('v1.96.0')),
    `a partial gap must not blame the LiteLLM version: ${all.join(' | ')}`,
  )
})

test('every reported line is also written to opencode own log', async () => {
  const logged: LoggedEntry[] = []
  const { logs, warns } = await runConfigHook(
    providerConfig('https://proxy-applog.test'),
    MIXED_ROUTES,
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
  const { result } = await runConfigHook(
    providerConfig('https://proxy-logfail.test'),
    MIXED_ROUTES,
    { logFails: true },
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  assert.ok(models['ai-gateway-gpt-5.4'], 'models must still be injected when logging fails')
})

// --- dead price-table options -----------------------------------------------
//
// Pricing came from `options.catalogURL` (and `options.pricingURL` before it)
// until the proxy could answer for itself. Neither is read any more. A config
// still carrying one was written by someone who wanted pricing, so the dead key
// is named rather than ignored — and nothing is fetched from it.
test('a config still carrying catalogURL is told the option is dead', async () => {
  const config = {
    provider: {
      [PROVIDER_KEY]: {
        options: {
          baseURL: 'https://proxy-staleopt.test/v1',
          apiKey: 'sk-test',
          catalogURL: 'https://catalog.example.com/model_prices_and_context_window.json',
        },
      } as Record<string, unknown>,
    },
  }
  const { warns } = await runConfigHook(config, PROXY_ROUTES)

  // Priced anyway — from the proxy, which is the whole point of the message.
  const entry = (config.provider[PROVIDER_KEY]!.models as Record<string, Record<string, unknown>>)[
    'ai-gateway-gpt-5.4'
  ]
  assert.ok(entry, 'discovery must still run')
  assert.deepEqual(entry.cost, GPT_54_COST)

  assert.ok(
    warns.some((l) => l.includes('options.catalogURL') && l.includes('no longer read')),
    `expected the dead option named, got: ${warns.join(' | ')}`,
  )
  // Asserted rather than merely arranged: an unrouted path throws inside a
  // swallowed call, so only the record proves nothing was fetched.
  assert.deepEqual(
    fetchedURLs.filter((u) => u.includes('model_prices_and_context_window')),
    [],
    'a dead price-table option must never be fetched',
  )
})

test('the pre-0.7.0 pricingURL spelling is named too', async () => {
  const config = {
    provider: {
      [PROVIDER_KEY]: {
        options: {
          baseURL: 'https://proxy-legacykey.test/v1',
          apiKey: 'sk-test',
          pricingURL: 'https://catalog.example.com/model_prices_and_context_window.json',
        },
      } as Record<string, unknown>,
    },
  }
  const { warns } = await runConfigHook(config, PROXY_ROUTES)

  assert.ok(
    warns.some((l) => l.includes('options.pricingURL') && l.includes('no longer read')),
    `expected the old spelling named, got: ${warns.join(' | ')}`,
  )
})

test('a provider with no dead options says nothing about them', async () => {
  const { warns } = await runConfigHook(providerConfig('https://proxy-clean.test/v1'), PROXY_ROUTES)
  assert.deepEqual(warns, [], `a correct config must warn about nothing: ${warns.join(' | ')}`)
})

test('an SDK without client.app.log does not lose every model', async () => {
  // Older opencode builds have no /log endpoint. The property access throws
  // synchronously, which `.catch()` cannot see — and an escaped throw here
  // takes the whole config hook down with it.
  resetReportedStaleOptions()
  const plugin = await loadTheOnePlugin()
  const config = providerConfig('https://proxy-nolog.test')
  const { result } = await captureConsole(() =>
    withFakeProxy(PROXY_ROUTES, async () => {
      const input = fakePluginInput([])
      delete (input.client as unknown as Record<string, unknown>).app
      const hooks = await plugin(input)
      await hooks.config?.(config as unknown as Config)
      return config
    }),
  )

  const models = (result.provider as Record<string, { models: Record<string, unknown> }>)[
    PROVIDER_KEY
  ]!.models
  assert.ok(models['ai-gateway-gpt-5.4'], 'the model must survive an unloggable host')
})

// 18 — the baseURL handed to the SDK.
//
// `normalizeBaseURL` accepts a baseURL with or without `/v1`, and discovery
// works either way. `@ai-sdk/openai-compatible` does not: it POSTs
// `${baseURL}/chat/completions`. Passing the user's spelling straight through
// produced a picker full of correctly-priced models that 404 on every request
// — with the summary line reporting complete success.
test('the SDK baseURL always carries /v1, whichever form was configured', async () => {
  for (const [configured, host] of [
    ['https://proxy-nov1.test', 'https://proxy-nov1.test'],
    ['https://proxy-withv1.test/v1', 'https://proxy-withv1.test'],
    ['https://proxy-slash.test/v1/', 'https://proxy-slash.test'],
  ] as const) {
    const config = providerConfig(configured)
    await runConfigHook(config, PROXY_ROUTES)

    const provider = config.provider[PROVIDER_KEY]!
    const options = provider.options as Record<string, unknown>
    assert.equal(options.baseURL, `${host}/v1`, `configured as ${configured}`)
    // The rest of the options block survives the rewrite.
    assert.equal(options.apiKey, 'sk-test', `apiKey lost for ${configured}`)
    // And discovery still ran against the normalized host.
    const models = provider.models as Record<string, unknown>
    assert.ok(models['ai-gateway-gpt-5.4'], `nothing injected for ${configured}`)
  }
})

// 19 — re-entry bookkeeping across repeated `config` passes.
//
// The plugin must keep telling its own earlier entries apart from the user's
// hand-written ones. Tracking only the ids added by the LATEST pass loses that
// after the first re-entry, and the summary then credits the user with models
// the plugin injected itself.
test('models we injected stay ours across repeated config passes', async () => {
  const config = providerConfig('https://proxy-reentry.test/v1')
  const models = () => config.provider[PROVIDER_KEY]!.models as Record<string, unknown>
  // Drop one injected id before each re-run, so the early-return guard does not
  // short-circuit and the remaining id goes down the already-injected branch.
  const dropOne = () => {
    delete models()['ai-gateway-gpt-5.4']
  }

  const { logs } = await runConfigHook(
    config,
    {
      '/v1/models': () => modelsResponse(CHAT_MODEL, { id: 'house-chat', object: 'model' }),
      '/v1/model/info': modelInfoRoute(
        ['ai-gateway-gpt-5.4', GPT_54_INFO],
        ['house-chat', GPT_54_INFO],
      ),
    },
    { rerun: [dropOne, dropOne] },
  )

  const summaries = logs.filter((l) => l.includes(' models, '))
  assert.equal(summaries.length, 3, `expected three summaries, got: ${logs.join(' | ')}`)
  // Passes 2 and 3 each re-add the dropped id and re-encounter `house-chat`,
  // which we injected on pass 1 — one added, one hidden, every pass.
  for (const [i, summary] of summaries.slice(1).entries()) {
    assert.ok(
      summary.includes('1 models, 1 priced, 1 hidden'),
      `pass ${i + 2} should re-add exactly the dropped id: ${summary}`,
    )
  }
  // Both ids are present at the end: the re-entry restored the dropped one
  // without disturbing the one it had already injected.
  assert.ok(models()['ai-gateway-gpt-5.4'], 'the dropped id was not re-added')
  assert.ok(models()['house-chat'], 'the surviving id was lost')
})

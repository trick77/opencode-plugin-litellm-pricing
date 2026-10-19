// End-to-end scenarios: the plugin set up the way opencode V2 sets it up,
// against a fake provider registry and a fake LiteLLM proxy. See
// test/helpers/fake-opencode-host.ts for what is faked and what that costs.
//
// Each scenario builds its own host and its own plugin instance; all plugin
// state lives in the `setup` closure, so nothing leaks between scenarios.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupLiteLLMPricing } from '../src/plugin.ts'
import {
  assertLoadable,
  fakeHost,
  fetched,
  json,
  reported,
  withFakeProxy,
  type ConfiguredProvider,
  type FakeHost,
  type FoldedRecord,
  type Routes,
} from './helpers/fake-opencode-host.ts'

const PROVIDER_KEY = 'opencode-plugin-litellm-pricing'

/** Let queued events and microtasks run, then wait for the plugin to go idle. */
async function settle(plugin: { idle: () => Promise<void> }) {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await plugin.idle()
  }
}

/**
 * Set the plugin up against `providers`, deliver one `provider.updated` (the
 * config provider registering itself after boot), and return the registry as
 * opencode would serve it, plus everything reported.
 */
async function run(
  providers: ConfiguredProvider[],
  routes: Routes,
  opts: { after?: (host: FakeHost, plugin: ReturnType<typeof setupLiteLLMPricing>) => Promise<void> } = {},
) {
  const out = reported()
  const host = fakeHost(providers)
  return withFakeProxy(routes, async () => {
    const plugin = setupLiteLLMPricing(host.ctx, out.report)
    try {
      host.emit('provider.updated')
      await settle(plugin)
      await opts.after?.(host, plugin)
      return { registry: host.fold(), host, logs: out.logs, warns: out.warns }
    } finally {
      plugin.dispose()
    }
  })
}

/** A provider shaped like a normalized V1 `provider.<id>.options` block. */
function provider(baseURL: string, extra: Partial<ConfiguredProvider> = {}): ConfiguredProvider {
  return {
    id: PROVIDER_KEY,
    // `package` deliberately omitted — the plugin should default it.
    settings: { baseURL, apiKey: 'sk-test' },
    ...extra,
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
  supports_reasoning: true,
}

/** The same prices as opencode V2 cost tiers, USD per 1M tokens. */
const GPT_54_COST = [
  { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
  { tier: { type: 'context', size: 200_000 }, input: 5, output: 22.5, cache: { read: 0.5, write: 0 } },
]

/** A /v1/model/info route serving one row per (name, info) pair. */
function modelInfoRoute(...rows: Array<[string, Record<string, unknown>]>) {
  return () => json({ data: rows.map(([model_name, model_info]) => ({ model_name, model_info })) })
}

const PROXY_ROUTES: Routes = {
  '/v1/models': () => modelsResponse(CHAT_MODEL),
  '/v1/model/info': modelInfoRoute(['ai-gateway-gpt-5.4', GPT_54_INFO]),
}

function modelsOf(registry: Map<string, FoldedRecord>, id = PROVIDER_KEY) {
  return registry.get(id)?.models ?? new Map()
}

// 1 — the loader contract. V2 decodes the default export only; a module whose
// default lacks `id` or `setup` is refused with exactly this message.
test('the entry module satisfies opencode V2\'s plugin loader', async () => {
  const mod = (await import('../src/index.ts')) as Record<string, unknown>
  const plugin = assertLoadable(mod)
  assert.equal(plugin.id, PROVIDER_KEY)
  // Named runtime exports are ignored by V2 but still a smell: types.ts
  // exports a value, and only `export type *` keeps it out of here.
  assert.deepEqual(
    Object.keys(mod).filter((k) => k !== 'default'),
    [],
    'no named runtime exports',
  )
  // The checkout-as-directory entry resolves to the same definition.
  const root = (await import('../index.ts')) as Record<string, unknown>
  assert.equal(assertLoadable(root), plugin)
})

// 1b — the shipped definition, set up through its own `setup`, wires itself up
// and cleans up after itself.
test('the default export sets up and tears down through opencode\'s lifecycle', async () => {
  const mod = (await import('../src/index.ts')) as Record<string, unknown>
  const plugin = assertLoadable(mod)
  const host = fakeHost()
  const cleanup = await plugin.setup(host.ctx)
  assert.equal(host.subscribers, 1, 'setup should subscribe to provider changes')
  assert.equal(typeof cleanup, 'function')
  await (cleanup as () => void)()
  assert.equal(host.subscribers, 0, 'cleanup should end the subscription')
})

// 2 — the happy path, all the way through.
test('injects discovered models with proxy pricing into the provider', async () => {
  const { registry, logs } = await run([provider('https://proxy-inject.test/v1')], PROXY_ROUTES)

  const record = registry.get(PROVIDER_KEY)!
  assert.equal(
    record.provider.package,
    '@opencode/ai/providers/openai-compatible',
    'a provider with no package should get the OpenAI-compatible route',
  )

  const model = modelsOf(registry).get('ai-gateway-gpt-5.4')
  assert.ok(model, 'the chat model should be injected')
  assert.equal(model.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(model.limit, { context: 1050000, output: 128000 })
  // Priced from LiteLLM's own resolved numbers, as V2 tiers. No cache write
  // price on the proxy → 0, because V2 requires the field.
  assert.deepEqual(model.cost, GPT_54_COST)
  assert.equal(model.capabilities.tools, true)
  assert.deepEqual(model.capabilities.input, ['text'])
  assert.deepEqual(
    model.variants.map((v: { id: string; settings?: Record<string, unknown> }) => [v.id, v.settings?.reasoningEffort]),
    [
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
    ],
    'supports_reasoning should yield reasoningEffort variants',
  )

  assert.ok(
    logs.some((l) => l.includes('1 models, 1 priced, 0 hidden')),
    `expected a priced summary, got: ${logs.join(' | ')}`,
  )
})

// 2b — the endpoint contract. /v2/model/info is the Admin UI listing and still
// needs an elevated key, so calling it would 403 exactly the keys this plugin
// is built for. Nothing outside the configured proxy may be fetched either.
test('only /v1/models and /v1/model/info are ever fetched', async () => {
  await run([provider('https://proxy-endpoints.test/v1')], PROXY_ROUTES, {
    after: async () => {
      assert.deepEqual(
        fetched.map((f) => f.url),
        ['https://proxy-endpoints.test/v1/models', 'https://proxy-endpoints.test/v1/model/info'],
        'the plugin must talk to the configured proxy and nothing else',
      )
    },
  })
})

// 2c — the V2 startup order. The config provider activates AFTER user plugins,
// so at setup time there is nothing to enrich; discovery has to start from the
// `provider.updated` that follows.
test('a provider that appears after setup is discovered on provider.updated', async () => {
  const out = reported()
  const host = fakeHost([])
  await withFakeProxy(PROXY_ROUTES, async () => {
    const plugin = setupLiteLLMPricing(host.ctx, out.report)
    try {
      await settle(plugin)
      assert.equal(fetched.length, 0, 'nothing to discover yet')
      assert.equal(host.transforms, 0, 'no transform before anything was found')

      host.configure([provider('https://proxy-late.test/v1')])
      host.emit('provider.updated')
      await settle(plugin)
      assert.ok(modelsOf(host.fold()).get('ai-gateway-gpt-5.4'), 'discovered once the provider exists')
    } finally {
      plugin.dispose()
    }
  })
})

// 2d — replays and repeated events. Every reload fires `provider.updated`
// again; re-discovering on each would be a request loop against the proxy.
test('repeated provider.updated with unchanged settings does not re-discover', async () => {
  await run([provider('https://proxy-once.test/v1')], PROXY_ROUTES, {
    after: async (host, plugin) => {
      host.emit('provider.updated')
      host.emit('provider.updated')
      await settle(plugin)
      assert.equal(fetched.length, 2, `expected one discovery, got: ${fetched.map((f) => f.url).join(', ')}`)
      assert.equal(host.transforms, 1, 'exactly one transform registration')
      // And the transform replays to the same result on every fold.
      assert.deepEqual(
        [...modelsOf(host.fold()).values()],
        [...modelsOf(host.fold()).values()],
      )
    },
  })
})

// 2e — a config edit pointing elsewhere is picked up without a restart.
test('a changed baseURL re-discovers against the new proxy', async () => {
  await run([provider('https://proxy-before.test/v1')], PROXY_ROUTES, {
    after: async (host, plugin) => {
      host.configure([provider('https://proxy-after.test/v1')])
      // Before rediscovery: the old proxy's inventory must not be replayed
      // onto the new URL, and the new URL must not be rewritten back to the
      // old one — that would hide the edit from the plugin itself.
      const stale = host.fold().get(PROVIDER_KEY)!
      assert.equal(stale.models.size, 0, 'stale inventory replayed onto a new proxy')
      assert.equal((stale.provider.settings as Record<string, unknown>).baseURL, 'https://proxy-after.test/v1')

      host.emit('provider.updated')
      await settle(plugin)
      assert.deepEqual(
        fetched.map((f) => new URL(f.url).host),
        ['proxy-before.test', 'proxy-before.test', 'proxy-after.test', 'proxy-after.test'],
      )
      const record = host.fold().get(PROVIDER_KEY)!
      assert.equal(
        (record.provider.settings as Record<string, unknown>).baseURL,
        'https://proxy-after.test/v1',
      )
    },
  })
})

// 3 — LiteLLM's own `mode` filters non-chat models. The id here is
// deliberately neutral: a name like `…-text-embedding-3-small` would be
// filtered by the id heuristics too, which would not prove the mode path ran.
test('non-chat models are filtered out by /v1/model/info mode', async () => {
  const { registry, logs } = await run([provider('https://proxy-mode.test/v1')], {
    '/v1/models': () => modelsResponse(CHAT_MODEL, { id: 'house-vectorizer', object: 'model' }),
    '/v1/model/info': modelInfoRoute(
      ['ai-gateway-gpt-5.4', GPT_54_INFO],
      ['house-vectorizer', { mode: 'embedding' }],
    ),
  })

  assert.ok(modelsOf(registry).get('ai-gateway-gpt-5.4'), 'the chat model should survive')
  assert.equal(modelsOf(registry).get('house-vectorizer'), undefined, 'the embedding model should be hidden')
  assert.ok(logs.some((l) => l.includes('1 models, 1 priced, 1 hidden')))
})

// 3b — the rename compatibility guarantee. Provider keys live in the user's
// opencode.json, so the pre-0.3.0 package name must keep matching.
test('the pre-rename provider id is still matched', async () => {
  const { registry } = await run(
    [provider('https://proxy-legacy-id.test/v1', { id: 'opencode-litellm-pricing' })],
    PROXY_ROUTES,
  )
  const model = modelsOf(registry, 'opencode-litellm-pricing').get('ai-gateway-gpt-5.4')
  assert.ok(model, 'the legacy provider id should still be enriched')
  // Pricing specifically — a matched-but-unpriced entry would be the silent
  // half-failure this guarantee exists to rule out.
  assert.deepEqual(model.cost, GPT_54_COST)
})

// 3c — the id prefixes and the opt-in flag, which V1 read off `options` and V2
// reads off `settings` (where opencode's normalization puts them).
test('litellm-* ids and the settings.litellm flag are matched', async () => {
  for (const p of [
    provider('https://proxy-prefix.test/v1', { id: 'litellm-work' }),
    provider('https://proxy-underscore.test/v1', { id: 'litellm_home' }),
    {
      id: 'gateway',
      settings: { baseURL: 'https://proxy-flag.test/v1', apiKey: 'sk-test', litellm: true },
    },
  ]) {
    const { registry } = await run([p], PROXY_ROUTES)
    assert.ok(modelsOf(registry, p.id).get('ai-gateway-gpt-5.4'), `${p.id} should be enriched`)
  }
})

// 3d — matching must not have become a free-for-all.
test('an unrelated provider id is left alone', async () => {
  const { registry, logs, warns, host } = await run(
    [{ id: 'anthropic', settings: { baseURL: 'https://proxy-unrelated.test/v1' } }],
    {},
  )
  assert.equal(registry.get('anthropic')!.models.size, 0, 'must not touch a foreign provider')
  assert.equal(host.transforms, 0)
  assert.deepEqual([...logs, ...warns], [], 'must say nothing about a provider it does not own')
})

// 4 — a matched provider with nothing to talk to.
test('a provider without settings.baseURL warns once and injects nothing', async () => {
  const { registry, warns } = await run([{ id: 'litellm', settings: {} }], {}, {
    after: async (host, plugin) => {
      host.emit('provider.updated')
      await settle(plugin)
    },
  })
  assert.equal(registry.get('litellm')!.models.size, 0, 'nothing should be injected')
  const baseURLWarnings = warns.filter((w) => w.includes('no settings.baseURL'))
  assert.equal(baseURLWarnings.length, 1, `expected one baseURL warning, got: ${warns.join(' | ')}`)
})

// 5 — an unreachable proxy must never break opencode.
test('a proxy that cannot be reached is survivable', async () => {
  const { registry, warns, host } = await run([provider('https://proxy-down.test/v1')], {
    '/v1/models': () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(modelsOf(registry).size, 0, 'no models should be injected')
  assert.equal(host.transforms, 0)
  assert.ok(
    warns.some((w) => w.includes('Model discovery failed')),
    `expected a discovery warning, got: ${warns.join(' | ')}`,
  )
})

// 5b — a failure is not retried on every unrelated provider change.
test('a failed discovery is not retried immediately', async () => {
  await run(
    [provider('https://proxy-down-again.test/v1')],
    {
      '/v1/models': () => {
        throw new Error('ECONNREFUSED')
      },
    },
    {
      after: async (host, plugin) => {
        host.emit('provider.updated')
        await settle(plugin)
        // One attempt = both endpoints, requested together.
        assert.equal(
          fetched.filter((f) => f.url.endsWith('/v1/models')).length,
          1,
          'retry must wait for the backoff window',
        )
      },
    },
  )
})

// 6 — /v1/model/info is best-effort: a proxy older than LiteLLM v1.96.0, or a
// key scoped to exclude the route, refuses it. Losing pricing must not cost
// the models themselves.
test('discovery still works when /v1/model/info is refused', async () => {
  const { registry, logs, warns } = await run([provider('https://proxy-noinfo.test/v1')], {
    '/v1/models': () =>
      modelsResponse(CHAT_MODEL, { id: 'ai-gateway-text-embedding-3-small', object: 'model' }),
    '/v1/model/info': () => json({ error: 'forbidden' }, 403),
  })

  const model = modelsOf(registry).get('ai-gateway-gpt-5.4')
  assert.ok(model, 'the chat model should still be injected')
  assert.deepEqual(model.cost, [], 'no info block means no cost, never a guessed one')
  // No `mode` available, so this one is caught by the id heuristics instead.
  assert.equal(modelsOf(registry).get('ai-gateway-text-embedding-3-small'), undefined)

  // Nothing priced at all is the systematic-failure shape, so it warns — and
  // names the cause, because "0 priced" alone sends people looking at their
  // model config rather than at their LiteLLM version.
  const summary = warns.find((l) => l.includes('1 models, 0 priced, 1 hidden'))
  assert.ok(summary, `expected the zero-coverage summary to warn, got: ${warns.join(' | ')}`)
  assert.ok(summary.includes('v1.96.0'), `the summary should name the version that fixes it: ${summary}`)
  // And the unpriced model is named, so the gap is diagnosable from the log.
  assert.ok(
    logs.some((l) => l.includes('no pricing: ai-gateway-gpt-5.4')),
    `expected the unpriced model named, got: ${logs.join(' | ')}`,
  )
})

// 6b — current LiteLLM emits `mode` on /v1/models itself, so a key that cannot
// read /v1/model/info loses pricing but keeps the non-chat filter.
test('the mode on /v1/models still filters when /v1/model/info is refused', async () => {
  const { registry, warns } = await run([provider('https://proxy-modeonly.test/v1')], {
    '/v1/models': () =>
      modelsResponse(
        { ...CHAT_MODEL, mode: 'chat' },
        { id: 'ai-gateway-veo-3.1', object: 'model', mode: 'video_generation' },
      ),
    '/v1/model/info': () => json({ error: 'forbidden' }, 403),
  })

  assert.ok(modelsOf(registry).get('ai-gateway-gpt-5.4'), 'the chat model should still be injected')
  // Nothing in `veo` says "video" to the id heuristics. Only `mode` knows.
  assert.equal(modelsOf(registry).get('ai-gateway-veo-3.1'), undefined)
  assert.ok(
    warns.some((l) => l.includes('1 models, 0 priced, 1 hidden')),
    `expected the hidden model counted, got: ${warns.join(' | ')}`,
  )
})

// 6c — the multi-deployment case, end to end.
test('a model group listed twice is priced from the deployment that resolved', async () => {
  const { registry } = await run([provider('https://proxy-dupes.test/v1')], {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/v1/model/info': modelInfoRoute(
      ['ai-gateway-gpt-5.4', { mode: 'chat' }],
      ['ai-gateway-gpt-5.4', GPT_54_INFO],
    ),
  })
  assert.deepEqual(modelsOf(registry).get('ai-gateway-gpt-5.4')!.cost, GPT_54_COST)
})

// 7 — the guarantee the README makes about hand-curated entries.
test('existing hand-curated model entries are never overwritten', async () => {
  const { registry, logs } = await run(
    [provider('https://proxy-curated.test/v1', { models: { 'ai-gateway-gpt-5.4': 'Hand Curated' } })],
    PROXY_ROUTES,
  )
  const model = modelsOf(registry).get('ai-gateway-gpt-5.4')!
  assert.equal(model.name, 'Hand Curated')
  assert.deepEqual(model.cost, [], 'the curated entry must not be repriced')
  // The entry surviving is not enough on its own — it would also survive if
  // discovery never ran. The summary line proves the model WAS discovered and
  // then deliberately skipped.
  assert.ok(
    logs.some((l) => l.includes('0 models, 0 priced, 1 hidden')),
    `expected discovery to have run and added nothing, got: ${logs.join(' | ')}`,
  )
})

// --- startup reporting ------------------------------------------------------

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
  const { logs, warns } = await run([provider('https://proxy-summary.test')], MIXED_ROUTES)
  const all = [...logs, ...warns]

  // 4 discovered = 2 added + 1 non-chat + 1 wildcard, and of the 2 added only
  // ai-gateway-gpt-5.4 has resolved costs.
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
  assert.ok(!all.some((l) => l.includes('v1.96.0')), `a partial gap must not blame the LiteLLM version`)
})

test('the summary is reported once per discovery, not once per fold', async () => {
  const { logs } = await run([provider('https://proxy-onesummary.test')], MIXED_ROUTES, {
    after: async (host, plugin) => {
      host.fold()
      host.fold()
      host.emit('provider.updated')
      await settle(plugin)
    },
  })
  assert.equal(logs.filter((l) => l.includes(' models, ')).length, 1, logs.join(' | '))
})

// --- credentials and headers --------------------------------------------------

test('the key and headers reach the proxy', async () => {
  await run(
    [
      provider('https://proxy-headers.test/v1', {
        settings: {
          baseURL: 'https://proxy-headers.test/v1',
          apiKey: 'sk-from-settings',
          customHeaders: { 'cf-access-client-id': 'abc' },
        },
        headers: { 'x-team': 'core' },
      }),
    ],
    PROXY_ROUTES,
    {
      after: async () => {
        for (const { headers } of fetched) {
          assert.equal(headers.Authorization, 'Bearer sk-from-settings')
          assert.equal(headers['cf-access-client-id'], 'abc', 'customHeaders (V1 option) must be sent')
          assert.equal(headers['x-team'], 'core', 'provider headers (V2) must be sent')
        }
      },
    },
  )
})

test('an empty apiKey (an unset {env:VAR}) falls back to LITELLM_API_KEY', async () => {
  const saved = process.env.LITELLM_API_KEY
  process.env.LITELLM_API_KEY = 'sk-from-env'
  try {
    await run(
      [provider('https://proxy-envkey.test/v1', { settings: { baseURL: 'https://proxy-envkey.test/v1', apiKey: '' } })],
      PROXY_ROUTES,
      {
        after: async () => {
          assert.equal(fetched[0]!.headers.Authorization, 'Bearer sk-from-env')
        },
      },
    )
  } finally {
    if (saved === undefined) delete process.env.LITELLM_API_KEY
    else process.env.LITELLM_API_KEY = saved
  }
})

// --- dead price-table options -----------------------------------------------
//
// Pricing came from `options.catalogURL` (and `options.pricingURL` before it)
// until the proxy could answer for itself. Neither is read any more. A config
// still carrying one was written by someone who wanted pricing, so the dead key
// is named rather than ignored — and nothing is fetched from it.
test('a config still carrying catalogURL is told the option is dead', async () => {
  const { registry, warns } = await run(
    [
      provider('https://proxy-staleopt.test/v1', {
        settings: {
          baseURL: 'https://proxy-staleopt.test/v1',
          apiKey: 'sk-test',
          catalogURL: 'https://catalog.example.com/model_prices_and_context_window.json',
        },
      }),
    ],
    PROXY_ROUTES,
    {
      after: async () => {
        // Asserted rather than merely arranged: an unrouted path throws inside
        // a swallowed call, so only the record proves nothing was fetched.
        assert.deepEqual(
          fetched.filter((f) => f.url.includes('model_prices_and_context_window')),
          [],
          'a dead price-table option must never be fetched',
        )
      },
    },
  )

  // Priced anyway — from the proxy, which is the whole point of the message.
  assert.deepEqual(modelsOf(registry).get('ai-gateway-gpt-5.4')!.cost, GPT_54_COST)
  assert.ok(
    warns.some((l) => l.includes('catalogURL') && l.includes('no longer read')),
    `expected the dead option named, got: ${warns.join(' | ')}`,
  )
})

test('the pre-0.7.0 pricingURL spelling is named too', async () => {
  const { warns } = await run(
    [
      provider('https://proxy-legacykey.test/v1', {
        settings: {
          baseURL: 'https://proxy-legacykey.test/v1',
          apiKey: 'sk-test',
          pricingURL: 'https://catalog.example.com/model_prices_and_context_window.json',
        },
      }),
    ],
    PROXY_ROUTES,
  )
  assert.ok(
    warns.some((l) => l.includes('pricingURL') && l.includes('no longer read')),
    `expected the old spelling named, got: ${warns.join(' | ')}`,
  )
})

test('a provider with no dead options says nothing about them', async () => {
  const { warns } = await run([provider('https://proxy-clean.test/v1')], PROXY_ROUTES)
  assert.deepEqual(warns, [], `a correct config must warn about nothing: ${warns.join(' | ')}`)
})

// --- the baseURL handed to the model route ------------------------------------
//
// `normalizeBaseURL` accepts a baseURL with or without `/v1`, and discovery
// works either way. The OpenAI-compatible route does not: it POSTs
// `${baseURL}/chat/completions`. Passing the user's spelling straight through
// produced a picker full of correctly-priced models that 404 on every request
// — with the summary line reporting complete success.
test('the provider baseURL always carries /v1, whichever form was configured', async () => {
  for (const [configured, host] of [
    ['https://proxy-nov1.test', 'https://proxy-nov1.test'],
    ['https://proxy-withv1.test/v1', 'https://proxy-withv1.test'],
    ['https://proxy-slash.test/v1/', 'https://proxy-slash.test'],
  ] as const) {
    const { registry } = await run([provider(configured)], PROXY_ROUTES)
    const record = registry.get(PROVIDER_KEY)!
    const settings = record.provider.settings as Record<string, unknown>
    assert.equal(settings.baseURL, `${host}/v1`, `configured as ${configured}`)
    // The rest of the settings survive the rewrite.
    assert.equal(settings.apiKey, 'sk-test', `apiKey lost for ${configured}`)
    assert.ok(record.models.get('ai-gateway-gpt-5.4'), `nothing injected for ${configured}`)
  }
})

test('a configured package is left alone', async () => {
  const { registry } = await run(
    [provider('https://proxy-pkg.test/v1', { package: 'aisdk:@ai-sdk/openai-compatible' })],
    PROXY_ROUTES,
  )
  assert.equal(registry.get(PROVIDER_KEY)!.provider.package, 'aisdk:@ai-sdk/openai-compatible')
})

// --- teardown -------------------------------------------------------------------

test('a provider removed from the config is not recreated by the transform', async () => {
  await run([provider('https://proxy-removed.test/v1')], PROXY_ROUTES, {
    after: async (host) => {
      host.configure([])
      assert.equal(host.fold().has(PROVIDER_KEY), false)
    },
  })
})

// --- failure handling and lifecycle -------------------------------------------
//
// Short timings so retries and resubscriptions happen within a test. The real
// values (60s retry floor, 1s–60s resubscribe backoff) only differ in size.

const FAST = { retryAfterMs: 20, resubscribeMinMs: 5, resubscribeMaxMs: 20 }

/** Poll `done` until it holds, letting the plugin settle in between. */
async function waitFor(done: () => boolean, plugin: { idle: () => Promise<void> }, what: string) {
  const deadline = Date.now() + 2000
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await plugin.idle()
  }
}

type PluginHandle = ReturnType<typeof setupLiteLLMPricing>

/** Set up with FAST timings against `providers`, run `body`, always dispose. */
async function withPlugin(
  providers: ConfiguredProvider[],
  routes: Routes,
  body: (host: FakeHost, plugin: PluginHandle, out: ReturnType<typeof reported>) => Promise<void>,
  prepare?: (host: FakeHost) => void,
) {
  const out = reported()
  const host = fakeHost(providers)
  prepare?.(host)
  await withFakeProxy(routes, async () => {
    const plugin = setupLiteLLMPricing(host.ctx, out.report, FAST)
    try {
      await body(host, plugin, out)
    } finally {
      plugin.dispose()
      await plugin.idle()
    }
  })
}

// A rejected registration used to escape discover(), leave the attempt marked
// in flight forever and `registered` already true — so the transform was never
// registered and the provider never retried.
test('a refused transform registration is reported and retried, not wedged', async () => {
  await withPlugin(
    [provider('https://proxy-refused.test/v1')],
    PROXY_ROUTES,
    async (host, plugin, out) => {
      await settle(plugin)
      assert.equal(host.transforms, 0)
      assert.ok(
        out.warns.some((w) => w.includes('could not apply discovered models')),
        `expected the refusal reported, got: ${out.warns.join(' | ')}`,
      )
      await waitFor(() => modelsOf(host.fold()).has('ai-gateway-gpt-5.4'), plugin, 'retry to inject')
      assert.equal(host.transforms, 1, 'registered exactly once after the retry')
    },
    (host) => {
      host.faults.transform = 1
    },
  )
})

// A proxy down at startup must not leave the picker empty until a restart,
// and nothing else may be needed to trigger the retry — no provider change.
test('a proxy down at startup is retried on a timer and recovers', async () => {
  let up = false
  await withPlugin(
    [provider('https://proxy-flaky.test/v1')],
    {
      '/v1/models': () => {
        if (!up) throw new Error('ECONNREFUSED')
        return modelsResponse(CHAT_MODEL)
      },
      '/v1/model/info': modelInfoRoute(['ai-gateway-gpt-5.4', GPT_54_INFO]),
    },
    async (host, plugin, out) => {
      await settle(plugin)
      assert.ok(out.warns.some((w) => w.includes('Model discovery failed')))
      up = true
      await waitFor(() => modelsOf(host.fold()).has('ai-gateway-gpt-5.4'), plugin, 'timer retry')
    },
  )
})

// The lost wakeup: an event arriving after the sync loop has decided to stop
// but before `running` was cleared raised `again` for a loop that no longer
// read it. Delivered at every microtask offset across the tail of a sync, a
// config change must always be acted on.
test('a provider change during the tail of a sync is never dropped', async () => {
  for (let depth = 0; depth < 40; depth++) {
    const a = provider(`https://proxy-wake-a${depth}.test/v1`)
    const b = provider(`https://proxy-wake-b${depth}.test/v1`)
    await withPlugin([a], PROXY_ROUTES, async (host, plugin) => {
      await settle(plugin)
      host.onList = () => {
        host.onList = undefined
        let n = depth
        const tick = (): void => {
          if (n-- > 0) return queueMicrotask(tick)
          host.configure([b])
          host.emit('provider.updated')
        }
        tick()
      }
      host.emit('provider.updated')
      await settle(plugin)
      await settle(plugin)
      assert.ok(
        fetched.some((f) => f.url.includes(`proxy-wake-b${depth}.test`)),
        `change at microtask offset ${depth} was dropped`,
      )
    })
  }
})

test('a broken event stream is reported once and resubscribed', async () => {
  await withPlugin(
    [],
    PROXY_ROUTES,
    async (host, plugin, out) => {
      await waitFor(() => host.subscribers === 1, plugin, 'resubscribe after two failures')
      assert.equal(host.subscriptions, 3)
      assert.equal(out.warns.filter((w) => w.includes('event stream')).length, 1, out.warns.join(' | '))

      // An ended stream (no error) is resubscribed too.
      host.endStreams()
      await waitFor(() => host.subscribers === 1 && host.subscriptions === 4, plugin, 'resubscribe after end')

      // And the new subscription works.
      host.configure([provider('https://proxy-resub.test/v1')])
      host.emit('provider.updated')
      await waitFor(() => modelsOf(host.fold()).has('ai-gateway-gpt-5.4'), plugin, 'discovery via new stream')
    },
    (host) => {
      host.faults.subscribe = 2
    },
  )
})

test('dispose aborts in-flight requests and skips the remaining providers', async () => {
  let aborted = false
  let started!: () => void
  const inFlight = new Promise<void>((resolve) => (started = resolve))
  const hanging = (signal?: AbortSignal) =>
    new Promise<Response>((_, reject) => {
      started()
      signal?.addEventListener('abort', () => {
        aborted = true
        reject(signal.reason)
      })
    })
  await withPlugin(
    [provider('https://proxy-hang.test/v1'), provider('https://proxy-next.test/v1', { id: 'litellm' })],
    {
      '/v1/models': hanging,
      '/v1/model/info': hanging,
    },
    async (host, plugin, out) => {
      await inFlight
      plugin.dispose()
      await plugin.idle()
      assert.equal(aborted, true, 'the in-flight request should be aborted')
      assert.equal(
        fetched.some((f) => f.url.includes('proxy-next.test')),
        false,
        'the next provider must not be fetched',
      )
      assert.equal(host.transforms, 0)
      assert.deepEqual(out.warns, [], 'an unload is not a discovery failure')
    },
  )
})

test('/v1/models and /v1/model/info are requested concurrently', async () => {
  let infoRequested!: () => void
  const info = new Promise<void>((resolve) => (infoRequested = resolve))
  await withPlugin(
    [provider('https://proxy-parallel.test/v1')],
    {
      // Answers only once /v1/model/info has also been asked for — a
      // sequential implementation times out here and injects nothing.
      '/v1/models': async () => {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('sequential')), 500))
        await Promise.race([info, timeout])
        return modelsResponse(CHAT_MODEL)
      },
      '/v1/model/info': () => {
        infoRequested()
        return modelInfoRoute(['ai-gateway-gpt-5.4', GPT_54_INFO])()
      },
    },
    async (host, plugin) => {
      await waitFor(() => modelsOf(host.fold()).has('ai-gateway-gpt-5.4'), plugin, 'parallel discovery')
      assert.deepEqual(modelsOf(host.fold()).get('ai-gateway-gpt-5.4')!.cost, GPT_54_COST)
    },
  )
})

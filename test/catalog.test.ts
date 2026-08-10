import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFromProviders } from '../src/catalog.ts'

// opencode provider objects (models.dev V2 Model shape: cost.cache.{read,write},
// experimentalOver200K, capabilities.toolcall, per-1M costs).
const PROVIDERS = [
  {
    id: 'azure',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        cost: { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
        limit: { context: 1050000, output: 128000 },
        capabilities: {
          reasoning: true,
          toolcall: true,
          attachment: true,
          input: { text: true, image: true, audio: false, video: false, pdf: true },
        },
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        cost: { input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } },
        limit: { context: 1050000, output: 128000 },
        capabilities: { toolcall: true, input: { text: true } },
      },
      'gpt-5-nano': {
        id: 'gpt-5-nano',
        cost: {
          input: 0.05,
          output: 0.4,
          cache: { read: 0.01, write: 0 },
          experimentalOver200K: { input: 0.1, output: 0.8, cache: { read: 0.02, write: 0 } },
        },
        limit: { context: 400000, output: 128000 },
        capabilities: { input: { text: true } },
      },
    },
  },
  {
    id: 'openai',
    models: {
      // Same id as azure — azure must win on the preference tie-break.
      'gpt-5.4': {
        id: 'gpt-5.4',
        cost: { input: 9.99, output: 9.99, cache: { read: 0, write: 0 } },
        limit: { context: 1, output: 1 },
        capabilities: { input: { text: true } },
      },
    },
  },
  {
    // Not a preferred provider — must be ignored entirely.
    id: 'someaggregator',
    models: { 'openai/gpt-5.4': { id: 'openai/gpt-5.4', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 1, output: 1 }, capabilities: { input: {} } } },
  },
]

const catalog = buildFromProviders(PROVIDERS)

test('longest match wins: …gpt-5.4-mini resolves to mini, not the base', () => {
  assert.equal(catalog.resolve('ai-gateway-gpt-5.4-mini')?.cost?.input, 0.75)
})

test('azure is preferred over openai on an id tie', () => {
  // Both providers have gpt-5.4; azure ($2.5) must win, not openai ($9.99).
  assert.equal(catalog.resolve('ai-gateway-gpt-5.4')?.cost?.input, 2.5)
})

test('boundary: gpt-5.45 does not match gpt-5.4', () => {
  assert.equal(catalog.resolve('foo-gpt-5.45'), null)
})

test('unmatched name resolves to null', () => {
  assert.equal(catalog.resolve('some-unknown-llama-thing'), null)
})

test('non-preferred providers are ignored (no aggregator leakage)', () => {
  // The only gpt-5.4 sources are azure/openai; the aggregator entry with a
  // slashy id must never be the match.
  const fields = catalog.resolve('ai-gateway-gpt-5.4')
  assert.equal(fields?.limit?.context, 1050000) // azure's limit, not the aggregator's 1
})

test('V2 cost shape maps to config cost, dropping zero cache tiers', () => {
  const fields = catalog.resolve('ai-gateway-gpt-5.4')!
  assert.deepEqual(fields.cost, { input: 2.5, output: 15, cache_read: 0.25 }) // cache.write 0 dropped
})

test('experimentalOver200K maps to context_over_200k', () => {
  const fields = catalog.resolve('router-gpt-5-nano')!
  assert.deepEqual(fields.cost, {
    input: 0.05,
    output: 0.4,
    cache_read: 0.01,
    context_over_200k: { input: 0.1, output: 0.8, cache_read: 0.02 },
  })
})

test('capabilities and modalities map through', () => {
  const fields = catalog.resolve('ai-gateway-gpt-5.4')!
  assert.equal(fields.reasoning, true)
  assert.equal(fields.tool_call, true)
  assert.equal(fields.attachment, true)
  assert.deepEqual(fields.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] })
})

// --- models.dev tiers -------------------------------------------------------
//
// models.dev publishes `cost.tiers[]` whose first entry is NOT necessarily the
// 200k band: live thresholds run from 16k to 512k, and models.dev omits
// `context_over_200k` exactly when no tier reaches 200k. Reading tiers[0] blind
// would bill a sub-200k band's price as the over-200k price.

const TIERED = [
  {
    id: 'azure',
    models: {
      // A 272k first tier — qualifies, and is how azure's real entries look.
      'tier-over': {
        id: 'tier-over',
        cost: {
          input: 2.5,
          output: 15,
          tiers: [{ input: 5, output: 22.5, cache_read: 0.5, tier: { type: 'context', size: 272000 } }],
        },
        limit: { context: 100, output: 100 },
      },
      // A 32k first tier — does NOT qualify; models.dev ships no
      // context_over_200k for models like this.
      'tier-under': {
        id: 'tier-under',
        cost: {
          input: 1,
          output: 2,
          tiers: [{ input: 9, output: 99, tier: { type: 'context', size: 32000 } }],
        },
        limit: { context: 100, output: 100 },
      },
      // Explicit field wins over any tier guessing.
      'tier-explicit': {
        id: 'tier-explicit',
        cost: {
          input: 1,
          output: 2,
          context_over_200k: { input: 3, output: 4 },
          tiers: [{ input: 9, output: 99, tier: { type: 'context', size: 16000 } }],
        },
        limit: { context: 100, output: 100 },
      },
    },
  },
]
const tiered = buildFromProviders(TIERED)

test('a first tier at or above 200k becomes context_over_200k', () => {
  assert.deepEqual(tiered.resolve('gw-tier-over')!.cost?.context_over_200k, {
    input: 5,
    output: 22.5,
    cache_read: 0.5,
  })
})

test('a first tier below 200k is NOT treated as the over-200k price', () => {
  // Billing the 32k band's $9/$99 as the over-200k rate would overcharge by 9x.
  assert.equal(tiered.resolve('gw-tier-under')!.cost?.context_over_200k, undefined)
})

test('an explicit context_over_200k beats the tiers array', () => {
  assert.deepEqual(tiered.resolve('gw-tier-explicit')!.cost?.context_over_200k, {
    input: 3,
    output: 4,
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFromTable } from '../src/catalog.ts'

// A price table in LiteLLM's published format: flat, keyed by model name,
// costs in USD per TOKEN, provider carried inside the entry.
const TABLE = {
  // LiteLLM's documentation stub. Never a model, never a candidate.
  sample_spec: {
    litellm_provider: 'one of the providers',
    input_cost_per_token: 999,
    output_cost_per_token: 999,
  },
  'azure/gpt-5.4': {
    litellm_provider: 'azure',
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.00000025,
    supports_function_calling: true,
    supports_reasoning: true,
    supports_vision: true,
    supports_pdf_input: true,
  },
  'azure/gpt-5.4-mini': {
    litellm_provider: 'azure',
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000075,
    output_cost_per_token: 0.0000045,
    supports_function_calling: true,
  },
  'azure/gpt-5-nano': {
    litellm_provider: 'azure',
    max_input_tokens: 400000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000005,
    output_cost_per_token: 0.0000004,
    cache_read_input_token_cost: 0.00000001,
    input_cost_per_token_above_200k_tokens: 0.0000001,
    output_cost_per_token_above_200k_tokens: 0.0000008,
    cache_read_input_token_cost_above_200k_tokens: 0.00000002,
  },
  // Same model line as azure — azure must win the preference tie-break.
  'gpt-5.4': {
    litellm_provider: 'openai',
    max_input_tokens: 1,
    max_output_tokens: 1,
    input_cost_per_token: 0.00000999,
    output_cost_per_token: 0.00000999,
  },
  // Not a preferred provider: reachable by exact key, never by substring.
  'someaggregator/gpt-5.4': {
    litellm_provider: 'someaggregator',
    max_input_tokens: 1,
    max_output_tokens: 1,
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
  // An enriched table's own entry — a gateway model name, priced exactly.
  'ai-gateway/gpt-5.4': {
    litellm_provider: 'ai-gateway',
    max_input_tokens: 400000,
    max_output_tokens: 100000,
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
  },
  // A regional azure key. Stripping only the leading `azure/` leaves `eu/…`,
  // which can never be a bounded substring of a plain model name — correct,
  // since regional prices differ and a model name says nothing about region.
  'azure/eu/gpt-5.4': {
    litellm_provider: 'azure',
    max_input_tokens: 1,
    max_output_tokens: 1,
    input_cost_per_token: 0.00000777,
    output_cost_per_token: 0.00000777,
  },
  // A 272k tier, which opencode has no bucket for: it must NOT be forced into
  // context_over_200k, or the 200k–272k band is overcharged.
  'azure/tier-272k': {
    litellm_provider: 'azure',
    max_input_tokens: 100,
    max_output_tokens: 100,
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.000015,
    input_cost_per_token_above_272k_tokens: 0.000005,
    output_cost_per_token_above_272k_tokens: 0.0000225,
  },
}

const catalog = buildFromTable(TABLE)

test('an exact key wins outright over any substring candidate', () => {
  // Both `ai-gateway/gpt-5.4` (exact) and `azure/gpt-5.4` (substring) could
  // answer. The enriched entry is the one the operator meant.
  assert.equal(catalog.resolve('ai-gateway/gpt-5.4')?.cost?.input, 1)
  assert.equal(catalog.resolve('ai-gateway/gpt-5.4')?.limit?.context, 400000)
})

test('an exact key matches case-insensitively', () => {
  assert.equal(catalog.resolve('AI-Gateway/GPT-5.4')?.cost?.input, 1)
})

test('an exact key works for providers outside the substring allow-list', () => {
  // `someaggregator` contributes no substring candidates, but its entry is
  // still the right answer when the proxy reports exactly that name.
  assert.deepEqual(catalog.resolve('someaggregator/gpt-5.4')?.cost, { input: 0, output: 0 })
})

test('longest match wins: …gpt-5.4-mini resolves to mini, not the base', () => {
  assert.equal(catalog.resolve('ai-gateway-gpt-5.4-mini')?.cost?.input, 0.75)
})

test('azure is preferred over openai on an id tie', () => {
  // Both providers carry gpt-5.4; azure ($2.50) must win, not openai ($9.99).
  assert.equal(catalog.resolve('ai-gateway-gpt-5.4')?.cost?.input, 2.5)
})

test('the provider prefix is stripped for substring matching', () => {
  // The key is `azure/gpt-5.4`; without stripping, no bounded substring of
  // `some-gateway-gpt-5.4` could ever contain the slash.
  assert.equal(catalog.resolve('some-gateway-gpt-5.4')?.limit?.context, 1050000)
})

test('a regional key never wins a substring match', () => {
  // `azure/eu/gpt-5.4` keeps `eu/` and so cannot match; the $7.77 regional
  // price must not leak onto a plain gateway model.
  assert.notEqual(catalog.resolve('some-gateway-gpt-5.4')?.cost?.input, 7.77)
})

test('boundary: gpt-5.45 does not match gpt-5.4', () => {
  assert.equal(catalog.resolve('foo-gpt-5.45'), null)
})

test('unmatched name resolves to null', () => {
  assert.equal(catalog.resolve('some-unknown-llama-thing'), null)
})

test('non-preferred providers leak nothing into the substring pass', () => {
  // The aggregator's free entry must never be what a gateway model matches.
  const fields = catalog.resolve('ai-gateway-gpt-5.4')
  assert.equal(fields?.limit?.context, 1050000) // azure's limit, not the aggregator's 1
})

test('sample_spec is never a candidate', () => {
  assert.equal(catalog.resolve('sample_spec'), null)
  // And its absurd per-token cost never reaches a real model.
  assert.notEqual(catalog.resolve('ai-gateway-gpt-5.4')?.cost?.input, 999_000_000)
})

test('per-token costs are scaled to per-1M', () => {
  // $0.0000025/token = $2.50 per 1M. Getting this wrong bills 1e6x off.
  assert.deepEqual(catalog.resolve('ai-gateway-gpt-5.4')!.cost, {
    input: 2.5,
    output: 15,
    cache_read: 0.25,
  })
})

test('the *_above_200k_tokens keys become context_over_200k', () => {
  assert.deepEqual(catalog.resolve('router-gpt-5-nano')!.cost, {
    input: 0.05,
    output: 0.4,
    cache_read: 0.01,
    context_over_200k: { input: 0.1, output: 0.8, cache_read: 0.02 },
  })
})

test('a 272k tier is NOT mapped into the 200k bucket', () => {
  // opencode's bucket starts at 200k; billing the 272k rate from 200k up
  // overcharges the band in between.
  assert.equal(catalog.resolve('gw-tier-272k')!.cost?.context_over_200k, undefined)
})

test('limits and capabilities map through', () => {
  const fields = catalog.resolve('ai-gateway-gpt-5.4')!
  assert.deepEqual(fields.limit, { context: 1050000, output: 128000 })
  assert.equal(fields.reasoning, true)
  assert.equal(fields.tool_call, true)
  assert.equal(fields.attachment, true)
  assert.deepEqual(fields.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] })
})

test('max_tokens stands in for a missing max_output_tokens', () => {
  const fields = buildFromTable({
    'azure/legacy': {
      litellm_provider: 'azure',
      max_input_tokens: 128000,
      max_tokens: 4096,
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    },
  }).resolve('azure/legacy')!
  assert.deepEqual(fields.limit, { context: 128000, output: 4096 })
})

// --- the shipped snapshot ---------------------------------------------------

test('the shipped snapshot round-trips into a usable catalog', async () => {
  // A snapshot in the wrong shape parses fine, builds an EMPTY catalog, and
  // quietly puts a blocking fetch back on every fresh install — so assert the
  // count, not just that it loaded.
  const { PRICE_TABLE_SNAPSHOT } = await import('../src/price-table-snapshot.ts')
  const snapshot = buildFromTable(PRICE_TABLE_SNAPSHOT as Record<string, unknown>)

  assert.ok(snapshot.candidateCount > 100, `snapshot has only ${snapshot.candidateCount} models`)
  assert.deepEqual([...snapshot.matchedProviders], ['azure', 'openai'])
  // Structural, never a pinned price: the snapshot is REGENERATED before every
  // release, so asserting upstream's current numbers here would turn a routine
  // `npm run update-snapshot` into a failing suite at tag time. Exact values
  // are pinned against fixtures above and in the host tests.
  const priced = snapshot.resolve('ai-gateway-gpt-4o')
  assert.ok(priced, 'the snapshot must price a gateway-prefixed model')
  assert.ok((priced.limit?.context ?? 0) > 0, 'a matched model must carry a context limit')
  assert.ok((priced.cost?.input ?? 0) > 0, 'a matched model must carry an input price')
  assert.ok((priced.cost?.output ?? 0) > 0, 'a matched model must carry an output price')
})

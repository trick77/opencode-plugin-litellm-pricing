import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCost, configModelFromCatalog } from '../src/build-config-model.ts'
import type { LiteLLMModel, LiteLLMModelInfo } from '../src/types.ts'

// Values below are taken verbatim from a real LiteLLM /v1/model/info
// response (USD per token) to lock the per-token -> per-1M conversion.

test('gpt-5.4: base cost converts to per-1M, no 200k tier (it tiers at 272k)', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
    cache_creation_input_token_cost: null,
    // present in the real payload, but at the 272k boundary — must be ignored
    input_cost_per_token_above_272k_tokens: 5e-6,
    output_cost_per_token_above_272k_tokens: 2.25e-5,
    input_cost_per_token_above_200k_tokens: null,
    output_cost_per_token_above_200k_tokens: null,
  } as LiteLLMModelInfo
  assert.deepEqual(buildCost(info), { input: 2.5, output: 15, cache_read: 0.25 })
})

test('gpt-5.4-mini: sub-dollar rates convert exactly', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 7.5e-8,
  }
  assert.deepEqual(buildCost(info), { input: 0.75, output: 4.5, cache_read: 0.075 })
})

test('gpt-5-nano: tiny rates convert without float noise beyond expectation', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 5e-8,
    output_cost_per_token: 4e-7,
    cache_read_input_token_cost: 5e-9,
  }
  const cost = buildCost(info)!
  assert.equal(cost.input, 0.05)
  assert.equal(cost.output, 0.4)
  assert.equal(cost.cache_read, 0.005)
})

test('genuine 200k-boundary model emits context_over_200k', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 2.25e-5,
  }
  assert.deepEqual(buildCost(info), {
    input: 3,
    output: 15,
    context_over_200k: { input: 6, output: 22.5 },
  })
})

test('a real 0 cost is kept, not dropped; cost omitted only when a rate is absent', () => {
  // 0 is a legitimate value (free tier) — keep it.
  assert.deepEqual(buildCost({ input_cost_per_token: 2e-8, output_cost_per_token: 0 }), {
    input: 0.02,
    output: 0,
  })
  // Missing input or output → no cost block (opencode requires both).
  assert.equal(buildCost({ input_cost_per_token: 2e-8 }), undefined)
  assert.equal(buildCost(undefined), undefined)
})

test('embedding-mode models are filtered out of the picker', () => {
  const model = { id: 'ai-gateway-text-embedding-3-small', object: 'model', mode: 'embedding' } as LiteLLMModel
  assert.equal(configModelFromCatalog(model, null), null)
})

test('rerank/moderation models are filtered out (only chat is injected)', () => {
  const rerank = { id: 'cohere-rerank-v3', object: 'model', mode: 'rerank' } as LiteLLMModel
  const moderation = { id: 'omni-moderation', object: 'model', mode: 'moderation' } as LiteLLMModel
  assert.equal(configModelFromCatalog(rerank, null), null)
  assert.equal(configModelFromCatalog(moderation, null), null)
})

test('a chat model with "audio" in its id is NOT hidden when mode is absent', () => {
  // gpt-4o-audio-preview is a chat model; the id heuristic must not hide it.
  const model = { id: 'gpt-4o-audio-preview', object: 'model' } as LiteLLMModel
  const entry = configModelFromCatalog(model, null)
  assert.notEqual(entry, null)
  assert.equal(entry!.name, 'GPT 4o Audio Preview')
})

test('limit uses max_tokens as the output fallback and never emits context 0', () => {
  // Only max_output known → no context window known → no limit (not context:0).
  const outputOnly = { id: 'm', object: 'model', mode: 'chat', max_output_tokens: 4096 } as LiteLLMModel
  assert.equal(configModelFromCatalog(outputOnly, null)!.limit, undefined)
  // max_tokens is LiteLLM's legacy alias for max output, used as the fallback.
  const withMaxTokens = {
    id: 'm2',
    object: 'model',
    mode: 'chat',
    max_input_tokens: 200000,
    max_tokens: 8192,
  } as LiteLLMModel
  assert.deepEqual(configModelFromCatalog(withMaxTokens, null)!.limit, { context: 200000, output: 8192 })
})

test('configModelFromCatalog: filters non-chat by name, applies catalog fields to chat', () => {
  // Embedding filtered even without mode (name heuristic).
  const embed = { id: 'ai-gateway-text-embedding-3-small', object: 'model' } as LiteLLMModel
  assert.equal(configModelFromCatalog(embed, null), null)

  // Chat model, no catalog match → bare entry (still injected).
  const chat = { id: 'ai-gateway-gpt-5.4', object: 'model' } as LiteLLMModel
  assert.deepEqual(configModelFromCatalog(chat, null), { name: 'AI Gateway GPT 5.4' })

  // Chat model with catalog fields → fields applied.
  const entry = configModelFromCatalog(chat, {
    cost: { input: 2.5, output: 15, cache_read: 0.25 },
    limit: { context: 1050000, output: 128000 },
    reasoning: true,
    tool_call: true,
  })!
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  assert.equal(entry.reasoning, true)
  assert.equal(entry.tool_call, true)
})

test('catalog fields are copied into each entry, never shared by reference', () => {
  // `catalog.resolve()` hands back the SAME CatalogFields object for every
  // model that matched one table entry. Assigning it straight in would put one
  // cost/limit/modalities object into several places in opencode's config.
  const fields = {
    cost: { input: 2.5, output: 15, context_over_200k: { input: 5, output: 22.5 } },
    limit: { context: 1050000, output: 128000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  }
  const a = configModelFromCatalog({ id: 'gw-gpt-5.4', object: 'model' } as LiteLLMModel, fields)!
  const b = configModelFromCatalog(
    { id: 'gw-gpt-5.4-eu', object: 'model' } as LiteLLMModel,
    fields,
  )!

  assert.notEqual(a.cost, b.cost, 'cost block shared between entries')
  assert.notEqual(a.limit, b.limit, 'limit block shared between entries')
  assert.notEqual(a.modalities, b.modalities, 'modalities shared between entries')
  // The nested tier too — a shallow copy would still alias it.
  assert.notEqual(
    (a.cost as { context_over_200k: unknown }).context_over_200k,
    (b.cost as { context_over_200k: unknown }).context_over_200k,
    'the over-200k tier is shared between entries',
  )
  // Nothing was aliased back to the catalog's own object either.
  assert.notEqual(a.cost, fields.cost, 'entry aliases the catalog cost object')
  assert.deepEqual(a.cost, fields.cost, 'the copy must carry the same values')
})

test('catalog modalities are unioned with LiteLLM flags, never shrunk by them', () => {
  // LiteLLM's group info reports vision only; the price table also knows pdf. The
  // narrower proxy answer must not drop pdf from the injected entry.
  const model = {
    id: 'bedrock-claude',
    object: 'model',
    mode: 'chat',
    supports_vision: true,
  } as LiteLLMModel
  const entry = configModelFromCatalog(model, {
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  })!
  assert.deepEqual(entry.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] })
})

test('chat model carries name, limit, cost, and capability flags', () => {
  const model: LiteLLMModel = {
    id: 'ai-gateway-gpt-5.4',
    object: 'model',
    mode: 'chat',
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    supports_function_calling: true,
    supports_reasoning: true,
    supports_vision: true,
  }
  // Cost comes from the catalog, the only source there is — the per-token
  // figures below are what buildCost() turns the table's entry into.
  const entry = configModelFromCatalog(model, {
    cost: buildCost({
      input_cost_per_token: 2.5e-6,
      output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 2.5e-7,
    }),
  })!
  assert.equal(entry.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
  assert.equal(entry.tool_call, true)
  assert.equal(entry.reasoning, true)
  assert.equal(entry.attachment, true)
})

test('a catalog mode hides a non-chat model that has no cost of its own', () => {
  // Entries like this carry a mode and little else — which is precisely enough
  // to keep a video generator out of the model picker.
  const model: LiteLLMModel = { id: 'gemini/veo-3.1-generate-preview', object: 'model' }
  assert.equal(configModelFromCatalog(model, { mode: 'video_generation' }), null)
})

test('mode is classification input and never reaches the emitted entry', () => {
  // opencode’s model schema has no `mode`; leaking it would put an unknown key
  // into the user’s provider config.
  const model: LiteLLMModel = { id: 'ai-gateway-gpt-5.4', object: 'model' }
  const entry = configModelFromCatalog(model, {
    mode: 'chat',
    cost: { input: 1, output: 2 },
  })!
  assert.equal('mode' in entry, false)
  assert.deepEqual(entry.cost, { input: 1, output: 2 })
})

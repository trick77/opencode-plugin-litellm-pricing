import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCost, enrichModel, modelSpecFromProxy } from '../src/build-model.ts'
import type { LiteLLMModel, LiteLLMModelInfo } from '../src/types.ts'

// Values below are taken verbatim from a real LiteLLM /v1/model/info
// response (USD per token) to lock the per-token -> per-1M conversion.

/** A V2 base tier. `cache` is required by opencode's schema; unknown → 0. */
const tier = (input: number, output: number, read = 0, write = 0) => ({
  input,
  output,
  cache: { read, write },
})

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
  assert.deepEqual(buildCost(info), [tier(2.5, 15, 0.25)])
})

test('gpt-5.4-mini: sub-dollar rates convert exactly', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 7.5e-8,
  }
  assert.deepEqual(buildCost(info), [tier(0.75, 4.5, 0.075)])
})

test('gpt-5-nano: tiny rates convert without float noise beyond expectation', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 5e-8,
    output_cost_per_token: 4e-7,
    cache_read_input_token_cost: 5e-9,
    cache_creation_input_token_cost: 6.25e-8,
  }
  const [base] = buildCost(info)
  assert.equal(base!.input, 0.05)
  assert.equal(base!.output, 0.4)
  assert.equal(base!.cache.read, 0.005)
  assert.equal(base!.cache.write, 0.0625)
})

test('genuine 200k-boundary model emits a second tier sized 200k', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 2.25e-5,
    cache_read_input_token_cost_above_200k_tokens: 6e-7,
  }
  assert.deepEqual(buildCost(info), [
    tier(3, 15),
    { tier: { type: 'context', size: 200_000 }, ...tier(6, 22.5, 0.6) },
  ])
})

test('a real 0 cost is kept, not dropped; unpriced only when a rate is absent', () => {
  // 0 is a legitimate value (free tier) — keep it.
  assert.deepEqual(buildCost({ input_cost_per_token: 2e-8, output_cost_per_token: 0 }), [
    tier(0.02, 0),
  ])
  // Missing input or output → no tiers at all (a V2 tier requires both).
  assert.deepEqual(buildCost({ input_cost_per_token: 2e-8 }), [])
  assert.deepEqual(buildCost(undefined), [])
})

test('a 200k tier missing a rate is dropped, the base tier stays', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 6e-6,
  }
  assert.deepEqual(buildCost(info), [tier(3, 15)])
})

test('embedding-mode models are filtered out of the picker', () => {
  const model = { id: 'ai-gateway-text-embedding-3-small', object: 'model', mode: 'embedding' } as LiteLLMModel
  assert.equal(modelSpecFromProxy(model, undefined), null)
})

test('rerank/moderation models are filtered out (only chat is injected)', () => {
  const rerank = { id: 'cohere-rerank-v3', object: 'model', mode: 'rerank' } as LiteLLMModel
  const moderation = { id: 'omni-moderation', object: 'model', mode: 'moderation' } as LiteLLMModel
  assert.equal(modelSpecFromProxy(rerank, undefined), null)
  assert.equal(modelSpecFromProxy(moderation, undefined), null)
})

test('a chat model with "audio" in its id is NOT hidden when mode is absent', () => {
  // gpt-4o-audio-preview is a chat model; the id heuristic must not hide it.
  const model = { id: 'gpt-4o-audio-preview', object: 'model' } as LiteLLMModel
  const spec = modelSpecFromProxy(model, undefined)
  assert.notEqual(spec, null)
  assert.equal(spec!.name, 'GPT 4o Audio Preview')
})

test('limit is emitted only with both sides known; max_tokens is the output fallback', () => {
  // One side alone would be paired with opencode's default for the other
  // (200k context / 32k output). A small known context with the default 32k
  // output asks for more tokens than the window holds → every request 400s.
  const contextOnly = { id: 'm0', object: 'model', mode: 'chat', max_input_tokens: 8192 } as LiteLLMModel
  assert.equal(modelSpecFromProxy(contextOnly, undefined)!.limit, undefined)
  const outputOnly = { id: 'm', object: 'model', mode: 'chat', max_output_tokens: 4096 } as LiteLLMModel
  assert.equal(modelSpecFromProxy(outputOnly, undefined)!.limit, undefined)
  // max_tokens is LiteLLM's legacy alias for max output, used as the fallback
  // — and never as the context window.
  const withMaxTokens = {
    id: 'm2',
    object: 'model',
    mode: 'chat',
    max_input_tokens: 200000,
    max_tokens: 8192,
  } as LiteLLMModel
  assert.deepEqual(modelSpecFromProxy(withMaxTokens, undefined)!.limit, { context: 200000, output: 8192 })
  // Nothing known → no limit at all.
  const bare = { id: 'm3', object: 'model', mode: 'chat', max_tokens: undefined } as LiteLLMModel
  assert.equal(modelSpecFromProxy(bare, undefined)!.limit, undefined)
})

test('modelSpecFromProxy: filters non-chat by name, prices chat from the info block', () => {
  // Embedding filtered even without mode (name heuristic).
  const embed = { id: 'ai-gateway-text-embedding-3-small', object: 'model' } as LiteLLMModel
  assert.equal(modelSpecFromProxy(embed, undefined), null)

  // Chat model with no info block at all → bare spec, still injected, unpriced.
  const chat = { id: 'ai-gateway-gpt-5.4', object: 'model' } as LiteLLMModel
  assert.deepEqual(modelSpecFromProxy(chat, undefined), {
    name: 'AI Gateway GPT 5.4',
    input: ['text'],
    reasoning: false,
    cost: [],
  })

  // Chat model whose info block carries costs and limits → priced.
  const info: LiteLLMModelInfo = {
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    supports_function_calling: true,
    supports_reasoning: true,
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
  }
  const spec = modelSpecFromProxy(enrichModel(chat, info), info)!
  assert.deepEqual(spec.cost, [tier(2.5, 15, 0.25)])
  assert.deepEqual(spec.limit, { context: 1050000, output: 128000 })
  assert.equal(spec.reasoning, true)
  assert.equal(spec.tools, true)
})

test('tools is stated only when the proxy said so either way', () => {
  // Unknown → undefined, so opencode's default (tools on) stands. An older
  // proxy must not switch tools off for every model it serves.
  const unknown = { id: 'gw-a', object: 'model', mode: 'chat' } as LiteLLMModel
  assert.equal(modelSpecFromProxy(unknown, undefined)!.tools, undefined)
  const off = { ...unknown, supports_function_calling: false }
  assert.equal(modelSpecFromProxy(off, undefined)!.tools, false)
})

test('cost tiers are built per spec, never shared by reference', () => {
  // Two model ids can resolve to the SAME info object out of the
  // /v1/model/info map — an alias, or a group listed twice. Handing that
  // object's cost straight through would put one tier into several models in
  // opencode's registry, where a later mutation would silently reprice the
  // others.
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 5e-6,
    output_cost_per_token_above_200k_tokens: 2.25e-5,
  }
  const a = modelSpecFromProxy({ id: 'gw-gpt-5.4', object: 'model' } as LiteLLMModel, info)!
  const b = modelSpecFromProxy({ id: 'gw-gpt-5.4-eu', object: 'model' } as LiteLLMModel, info)!

  assert.notEqual(a.cost, b.cost, 'cost array shared between specs')
  for (let i = 0; i < a.cost.length; i++) {
    assert.notEqual(a.cost[i], b.cost[i], `tier ${i} shared between specs`)
    assert.notEqual(a.cost[i]!.cache, b.cost[i]!.cache, `tier ${i} cache shared between specs`)
  }
  // The tier marker too — a shallow copy would still alias it.
  assert.notEqual(a.cost[1]!.tier, b.cost[1]!.tier, 'the over-200k marker is shared between specs')
  assert.deepEqual(a.cost, b.cost, 'both specs must carry the same values')
})

test('capability flags from the info block reach the spec as input modalities', () => {
  // /v1/models carries no capability flags, so every one of these comes from
  // the overlaid info block. A model that lost them would reach the picker
  // unable to take the attachments it actually supports.
  const model = { id: 'bedrock-claude', object: 'model', mode: 'chat' } as LiteLLMModel
  const info: LiteLLMModelInfo = { supports_vision: true, supports_pdf_input: true }
  const spec = modelSpecFromProxy(enrichModel(model, info), info)!
  assert.deepEqual(spec.input, ['text', 'image', 'pdf'])
})

test('input is text-only when the proxy claims nothing more', () => {
  // opencode's own default claims `image` too; a model nobody said can see
  // must not be offered image attachments.
  const model = { id: 'gw-text', object: 'model', mode: 'chat' } as LiteLLMModel
  assert.deepEqual(modelSpecFromProxy(model, undefined)!.input, ['text'])
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
  // Cost comes from the proxy's own resolved numbers, the only source there is.
  const spec = modelSpecFromProxy(model, {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
  })!
  assert.equal(spec.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(spec.limit, { context: 1050000, output: 128000 })
  assert.deepEqual(spec.cost, [tier(2.5, 15, 0.25)])
  assert.equal(spec.tools, true)
  assert.equal(spec.reasoning, true)
  assert.deepEqual(spec.input, ['text', 'image'])
})

test('an info-block mode hides a non-chat model that has no cost of its own', () => {
  // Entries like this carry a mode and little else — which is precisely enough
  // to keep a video generator out of the model picker.
  const model: LiteLLMModel = { id: 'gemini/veo-3.1-generate-preview', object: 'model' }
  const info: LiteLLMModelInfo = { mode: 'video_generation' }
  assert.equal(modelSpecFromProxy(enrichModel(model, info), info), null)
})

test('mode is classification input and never reaches the emitted spec', () => {
  // opencode's model schema has no `mode`; leaking it would put an unknown key
  // into opencode's model registry.
  const model: LiteLLMModel = { id: 'ai-gateway-gpt-5.4', object: 'model' }
  const info: LiteLLMModelInfo = {
    mode: 'chat',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
  }
  const spec = modelSpecFromProxy(enrichModel(model, info), info)!
  assert.equal('mode' in spec, false)
  assert.deepEqual(spec.cost, [tier(1, 2)])
})

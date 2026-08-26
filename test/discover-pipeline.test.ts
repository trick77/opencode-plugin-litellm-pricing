import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverLiteLLMModelInfo } from '../src/litellm-api.ts'
import { configModelFromProxy, enrichModel } from '../src/build-config-model.ts'
import type { LiteLLMModel, LiteLLMModelInfo } from '../src/types.ts'

// Shaped after LiteLLM's /v1/model/info response: one row per deployment,
// keyed by model_name (the same string /v1/models reports as an id), each
// carrying a `model_info` block that is the resolved price-map entry.
const MODEL_INFO_FIXTURE = {
  data: [
    {
      model_name: 'ai-gateway-gpt-5.4',
      litellm_params: { model: 'azure/gpt-5.4' },
      model_info: {
        mode: 'chat',
        max_input_tokens: 1050000,
        max_output_tokens: 128000,
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000015,
        supports_function_calling: true,
        supports_reasoning: true,
        supports_vision: true,
      },
    },
    { model_name: 'text-embedding-3-large', model_info: { mode: 'embedding' } },
    { model_name: 'acme-ranker', model_info: { mode: 'rerank' } },
    { model_name: 'acme-painter', model_info: { mode: 'image_generation' } },
    // LiteLLM emits mode: null for models with no price-map entry.
    { model_name: 'llava-hf', model_info: { mode: null } },
  ],
}

/**
 * Stub `fetch`, recording the URL each call targeted. The URL matters: the
 * plugin swallows any failure from this endpoint, so a wrong path degrades
 * silently to the name heuristics instead of failing a test.
 */
function mockFetchOnce(payload: unknown, calls: string[] = []) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return { ok: true, status: 200, statusText: 'OK', json: async () => payload }
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function mockFetchStatus(status: number, statusText: string) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    ({ ok: false, status, statusText, json: async () => ({}) })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

/** The live path: enrich with the info block where present, then build the entry. */
function inject(
  model: LiteLLMModel,
  infoByName: Map<string, LiteLLMModelInfo> | null,
): Record<string, unknown> | null {
  const info = infoByName?.get(model.id)
  const enriched = info ? enrichModel(model, info) : model
  return configModelFromProxy(enriched, info)
}

test('model info keys by model_name — the same id /v1/models reports', async () => {
  const calls: string[] = []
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE, calls)
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    // /v1/model/info, never /v2/model/info: only /model/info and
    // /v1/model/info are in llm_api_routes (LiteLLM v1.96.0+); /v2 still needs
    // an elevated key. The caller swallows a 403, so assert the path here or
    // every proxy silently prices nothing.
    assert.deepEqual(calls, ['http://proxy/v1/model/info'])
    assert.equal(infoByName.size, 5)
    assert.equal(infoByName.get('ai-gateway-gpt-5.4')?.mode, 'chat')
    assert.equal(infoByName.get('acme-ranker')?.mode, 'rerank')
  } finally {
    restore()
  }
})

test('mode filters non-chat models that no name heuristic would catch', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    // None of these ids look non-chat; only LiteLLM's own `mode` reveals them.
    for (const id of ['acme-ranker', 'acme-painter', 'text-embedding-3-large']) {
      assert.equal(inject({ id, object: 'model' }, infoByName), null, id)
    }
  } finally {
    restore()
  }
})

test('model info supplies cost, limits and capabilities to the injected entry', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    const entry = inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, infoByName)!
    assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
    assert.equal(entry.tool_call, true)
    assert.equal(entry.reasoning, true)
    assert.equal(entry.attachment, true)
    // Per-token USD scaled to per-million.
    assert.deepEqual(entry.cost, { input: 2.5, output: 15 })
  } finally {
    restore()
  }
})

test('a deployment with no resolved cost injects unpriced, not at $0', async () => {
  const restore = mockFetchOnce({
    data: [{ model_name: 'byo-llama', model_info: { mode: 'chat', max_input_tokens: 8192 } }],
  })
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    const entry = inject({ id: 'byo-llama', object: 'model' }, infoByName)!
    // A missing base_model mapping means LiteLLM resolves no cost fields at
    // all. Omitting `cost` is the honest answer; a 0 would read as free.
    assert.equal(entry.cost, undefined)
    assert.equal(entry.name, 'Byo Llama')
  } finally {
    restore()
  }
})

test('a priced deployment wins over an unpriced one in the same model group', async () => {
  const restore = mockFetchOnce({
    data: [
      // Same model_name twice: the first deployment has no base_model mapping,
      // the second resolves. First-row-wins would have priced the group at $0.
      { model_name: 'ai-gateway-gpt-5.4', model_info: { mode: 'chat' } },
      {
        model_name: 'ai-gateway-gpt-5.4',
        model_info: { mode: 'chat', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      },
    ],
  })
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    assert.equal(infoByName.size, 1)
    const entry = inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, infoByName)!
    assert.deepEqual(entry.cost, { input: 1, output: 2 })
  } finally {
    restore()
  }
})

test('a later unpriced deployment does not clobber the priced one', async () => {
  const restore = mockFetchOnce({
    data: [
      {
        model_name: 'ai-gateway-gpt-5.4',
        model_info: { mode: 'chat', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      },
      { model_name: 'ai-gateway-gpt-5.4', model_info: { mode: 'chat' } },
    ],
  })
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    const entry = inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, infoByName)!
    assert.deepEqual(entry.cost, { input: 1, output: 2 })
  } finally {
    restore()
  }
})

test('mode null falls back to the name heuristic rather than hiding the model', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const infoByName = await discoverLiteLLMModelInfo('http://proxy')
    // Present in the map, but with mode: null — that means "no signal", not
    // "not a chat model". A deny-list would have dropped it.
    const entry = inject({ id: 'llava-hf', object: 'model' }, infoByName)
    assert.notEqual(entry, null)
    assert.equal(entry!.name, 'Llava HF')
  } finally {
    restore()
  }
})

test('a refused /v1/model/info falls open — models still inject, unpriced', async () => {
  const restore = mockFetchStatus(403, 'Forbidden')
  try {
    await assert.rejects(discoverLiteLLMModelInfo('http://proxy'), /403/)
  } finally {
    restore()
  }
  // With infoByName = null the pipeline classifies by id: chat stays, embedding goes.
  const chat = inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, null)
  assert.notEqual(chat, null)
  assert.equal(chat!.cost, undefined)
  assert.equal(inject({ id: 'text-embedding-3-large', object: 'model' }, null), null)
  // ...and the reranker no name heuristic would catch is the cost of falling open.
  assert.notEqual(inject({ id: 'acme-ranker', object: 'model' }, null), null)
})

test('a refused /v1/model/info still classifies by the mode on /v1/models', () => {
  // Current LiteLLM emits mode on /v1/models itself, so a key that cannot read
  // /v1/model/info loses pricing but keeps the non-chat filter.
  assert.equal(inject({ id: 'acme-ranker', object: 'model', mode: 'rerank' }, null), null)
  const chat = inject({ id: 'acme-thinker', object: 'model', mode: 'chat' }, null)
  assert.notEqual(chat, null)
  assert.equal(chat!.cost, undefined)
})

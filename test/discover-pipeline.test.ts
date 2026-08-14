import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverLiteLLMModelGroups } from '../src/litellm-api.ts'
import {
  configModelFromCatalog,
  enrichModel,
  groupInfoToModelInfo,
} from '../src/build-config-model.ts'
import type { LiteLLMModel, LiteLLMModelGroupInfo } from '../src/types.ts'

// Shaped after LiteLLM's documented /model_group/info response: keyed by
// model_group (the same string /v1/models reports as an id), carrying `mode`
// and the capability flags, and no cost fields.
const MODEL_GROUP_FIXTURE = {
  data: [
    {
      model_group: 'ai-gateway-gpt-5.4',
      providers: ['azure'],
      max_input_tokens: 1050000,
      max_output_tokens: 128000,
      mode: 'chat',
      supports_function_calling: true,
      supports_reasoning: true,
      supports_vision: true,
    },
    { model_group: 'text-embedding-3-large', providers: ['openai'], mode: 'embedding' },
    { model_group: 'acme-ranker', providers: ['cohere'], mode: 'rerank' },
    { model_group: 'acme-painter', providers: ['openai'], mode: 'image_generation' },
    // LiteLLM emits mode: null for models with no price-map entry.
    { model_group: 'llava-hf', providers: ['openai'], mode: null },
  ],
}

/**
 * Stub `fetch`, recording the URL each call targeted. The URL matters: the
 * plugin swallows any failure from the metadata endpoint, so a wrong path
 * degrades silently to the name heuristics instead of failing a test.
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

/** The live path: enrich with group info where present, then build the entry. */
function inject(
  model: LiteLLMModel,
  groups: Map<string, LiteLLMModelGroupInfo> | null,
): Record<string, unknown> | null {
  const group = groups?.get(model.id)
  const enriched = group ? enrichModel(model, groupInfoToModelInfo(group)) : model
  return configModelFromCatalog(enriched, null)
}

test('model groups key by model_group — the same id /v1/models reports', async () => {
  const calls: string[] = []
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE, calls)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    // LiteLLM registers this endpoint WITHOUT a /v1 prefix (unlike
    // /model/info, which it aliases both ways). /v1/model_group/info 404s,
    // and the caller swallows that — so assert the path here or the whole
    // mode-based filter silently never runs against a real proxy.
    assert.deepEqual(calls, ['http://proxy/model_group/info'])
    assert.equal(groups.size, 5)
    assert.equal(groups.get('ai-gateway-gpt-5.4')?.mode, 'chat')
    assert.equal(groups.get('acme-ranker')?.mode, 'rerank')
  } finally {
    restore()
  }
})

test('group mode filters non-chat models that no name heuristic would catch', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    // None of these ids look non-chat; only LiteLLM's own `mode` reveals them.
    for (const id of ['acme-ranker', 'acme-painter', 'text-embedding-3-large']) {
      assert.equal(inject({ id, object: 'model' }, groups), null, id)
    }
  } finally {
    restore()
  }
})

test('group info supplies limits and capabilities to the injected entry', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    const entry = inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, groups)!
    assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
    assert.equal(entry.tool_call, true)
    assert.equal(entry.reasoning, true)
    assert.equal(entry.attachment, true)
    // Cost never comes from the proxy — the group endpoint carries none.
    assert.equal(entry.cost, undefined)
  } finally {
    restore()
  }
})

test('mode null falls back to the name heuristic rather than hiding the model', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    // Present in the map, but with mode: null — that means "no signal", not
    // "not a chat model". A deny-list would have dropped it.
    const entry = inject({ id: 'llava-hf', object: 'model' }, groups)
    assert.notEqual(entry, null)
    assert.equal(entry!.name, 'Llava HF')
  } finally {
    restore()
  }
})

test('a refused /model_group/info falls open — models still inject, by name', async () => {
  const restore = mockFetchStatus(403, 'Forbidden')
  try {
    await assert.rejects(discoverLiteLLMModelGroups('http://proxy'), /403/)
  } finally {
    restore()
  }
  // With groups = null the pipeline classifies by id: chat stays, embedding goes.
  assert.notEqual(inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, null), null)
  assert.equal(inject({ id: 'text-embedding-3-large', object: 'model' }, null), null)
  // ...and the reranker no name heuristic would catch is the cost of falling open.
  assert.notEqual(inject({ id: 'acme-ranker', object: 'model' }, null), null)
})

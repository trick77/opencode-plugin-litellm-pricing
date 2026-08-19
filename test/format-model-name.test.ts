import { test } from 'node:test'
import assert from 'node:assert/strict'
import { categorizeModel, formatModelName } from '../src/format-model-name.ts'
import type { LiteLLMModel, ModelType } from '../src/types.ts'

/** Build a bare /v1/models-shaped entry (no `mode`, as the real endpoint sends). */
function m(id: string, mode?: string | null): LiteLLMModel {
  return { id, object: 'model', ...(mode === undefined ? {} : { mode: mode ?? undefined }) }
}

// --- mode: the authoritative signal -----------------------------------------

test('chat modes are the allow-list', () => {
  for (const mode of ['chat', 'completion', 'responses', 'CHAT']) {
    assert.equal(categorizeModel(m('anything', mode)), 'chat', mode)
  }
})

test('known non-chat modes classify by kind', () => {
  const cases: Array<[string, ModelType]> = [
    ['embedding', 'embedding'],
    ['image_generation', 'image'],
    ['audio_transcription', 'audio'],
    ['audio_speech', 'audio'],
  ]
  for (const [mode, expected] of cases) {
    assert.equal(categorizeModel(m('anything', mode)), expected, mode)
  }
})

test('rerank, moderation and search are non-chat', () => {
  for (const mode of ['rerank', 'moderation', 'search']) {
    assert.equal(categorizeModel(m('anything', mode)), 'unknown', mode)
  }
})

test('an unrecognised mode is non-chat, not silently passed to the heuristics', () => {
  // The old deny-list fell through here, so `image_edit` on a plainly-named
  // model was injected as chat.
  assert.equal(categorizeModel(m('acme-renderer', 'image_edit')), 'unknown')
  assert.equal(categorizeModel(m('acme-thing', 'embed')), 'unknown')
})

test('mode null or absent falls through to the id heuristics', () => {
  // LiteLLM emits mode: null for models it has no price-map entry for; that
  // means "no signal", NOT "not a chat model".
  assert.equal(categorizeModel(m('my-local-llama', null)), 'chat')
  assert.equal(categorizeModel(m('my-local-llama')), 'chat')
  // ...and the heuristics still apply to a null-mode non-chat model.
  assert.equal(categorizeModel(m('bge-reranker-v2-m3', null)), 'unknown')
})

// --- id heuristics: the fallback --------------------------------------------

test('rerank and moderation models are caught by id', () => {
  for (const id of ['rerank-v3.5', 'cohere/rerank-multilingual-v3.0', 'bge-reranker-v2-m3']) {
    assert.equal(categorizeModel(m(id)), 'unknown', id)
  }
  for (const id of ['text-moderation-latest', 'omni-moderation-latest']) {
    assert.equal(categorizeModel(m(id)), 'unknown', id)
  }
})

test('embedding models are caught by id, including vendor-named ones', () => {
  for (const id of [
    'text-embedding-3-small',
    'azure/embed-english-v3',
    'voyage-3',
    'voyage-code-3',
    'bge-m3',
    'jina-embeddings-v3',
    'jina-clip-v2',
  ]) {
    assert.equal(categorizeModel(m(id)), 'embedding', id)
  }
})

test('audio models are caught by id, including speech vendors', () => {
  for (const id of [
    'whisper-1',
    'azure/tts-hd',
    'elevenlabs/eleven-v3',
    'cartesia/sonic-2',
    'deepgram/nova-3',
  ]) {
    assert.equal(categorizeModel(m(id)), 'audio', id)
  }
})

test('image models are caught by id, including modern names', () => {
  for (const id of [
    'dall-e-3',
    'stable-diffusion-xl',
    'gpt-image-1',
    'imagen-3.0-generate-002',
    'xai/grok-2-image-1212',
    'seedream-4',
    'sd3',
  ]) {
    assert.equal(categorizeModel(m(id)), 'image', id)
  }
})

// --- the asymmetry: never hide a usable chat model ---------------------------

test('chat models that merely look non-chat are NOT hidden', () => {
  // Each of these has burned someone on a broader pattern:
  // `nova` (deepgram/nova-3 is speech, this one is not), a bare `audio`
  // substring, `gte`/`e5` as embedding families, `search` as a mode.
  for (const id of [
    'amazon.nova-pro-v1:0',
    'amazon.nova-lite-v1:0',
    'gpt-4o-audio-preview',
    'gpt-4o-search-preview',
    'gpt-5.4',
    'ai-gateway-gpt-5.4-mini',
    // `-image` followed by a word, not a version — reading images is a chat
    // capability; generating them is not.
    'acme-vision-image-understanding',
  ]) {
    assert.equal(categorizeModel(m(id)), 'chat', id)
  }
})

test('an explicit chat mode overrides a non-chat-looking id', () => {
  // If LiteLLM says it is a chat model, believe it over the name.
  assert.equal(categorizeModel(m('acme-embed-chat', 'chat')), 'chat')
})

// --- catalog mode: the keyless third signal ---------------------------------
//
// The proxy's `mode` arrives from /model_group/info, which LiteLLM closes to
// any key created as `key_type: "llm_api"`. The catalog's `mode` needs no key,
// so on those proxies it is the ONLY real classification signal there is.

test('a catalog mode hides a non-chat model whose id says nothing', () => {
  // The gap this signal exists to close: no keyword in the id, no proxy mode,
  // so before the catalog these reached the picker as chat models.
  const cases: Array<[string, string, ModelType]> = [
    ['gemini/veo-3.1-generate-preview', 'video_generation', 'unknown'],
    ['azure_ai/mistral-document-ai-2505', 'ocr', 'unknown'],
    ['perplexity/search', 'search', 'unknown'],
    ['azure/gpt-4o-realtime-preview', 'realtime', 'unknown'],
    ['stability/inpaint', 'image_edit', 'unknown'],
    ['amazon.nova-canvas-v1:0', 'image_generation', 'image'],
    ['databricks/databricks-gte-large-en', 'embedding', 'embedding'],
  ]
  for (const [id, catalogMode, expected] of cases) {
    assert.equal(categorizeModel(m(id), catalogMode), expected, id)
  }
})

test('catalog chat modes keep a model visible', () => {
  // `responses` and `completion` are chat modes. Reading them as non-chat would
  // hide the o1-pro/codex family — a far worse failure than the one being fixed.
  for (const mode of ['chat', 'completion', 'responses']) {
    assert.equal(categorizeModel(m('acme-gateway-model'), mode), 'chat', mode)
  }
})

test('the proxy mode wins over a conflicting catalog mode', () => {
  // The proxy knows what it actually deployed; the catalog matched a name.
  assert.equal(categorizeModel(m('acme-model', 'chat'), 'embedding'), 'chat')
  assert.equal(categorizeModel(m('acme-model', 'embedding'), 'chat'), 'embedding')
})

test('a non-chat id beats a catalog claiming chat', () => {
  // The catalog match may be a SUBSTRING, so `acme-embed-v1` can resolve to a
  // chat entry it merely contains. The id heuristics are the narrower signal
  // and stay ahead of it.
  assert.equal(categorizeModel(m('acme-embed-v1'), 'chat'), 'embedding')
  assert.equal(categorizeModel(m('bge-reranker-v2-m3'), 'chat'), 'unknown')
})

test('an empty catalog mode is no signal, not a non-chat verdict', () => {
  assert.equal(categorizeModel(m('acme-model'), ''), 'chat')
  assert.equal(categorizeModel(m('acme-model'), undefined), 'chat')
})

// --- display names -----------------------------------------------------------

test('formatModelName strips the provider prefix and title-cases', () => {
  assert.equal(formatModelName(m('azure/ai-gateway-gpt-5.4')), 'AI Gateway GPT 5.4')
  assert.equal(formatModelName(m('claude-opus-5')), 'Claude Opus 5')
})

test('short words are title-cased; only real acronyms are shouted', () => {
  // The old rule was `length <= 3 -> toUpperCase()`, which shouted every short
  // WORD too — `Gemini 2.5 PRO` sitting next to a correctly-cased `Mini`.
  assert.equal(formatModelName(m('gemini-2.5-pro')), 'Gemini 2.5 Pro')
  assert.equal(formatModelName(m('grok-4-fast-max')), 'Grok 4 Fast Max')
  assert.equal(formatModelName(m('claude-haiku-4-5-air')), 'Claude Haiku 4 5 Air')
  // ...while genuine acronyms still are.
  assert.equal(formatModelName(m('gpt-4o-mini')), 'GPT 4o Mini')
  assert.equal(formatModelName(m('llava-hf')), 'Llava HF')
  assert.equal(formatModelName(m('qwen2-vl-7b')), 'qwen2 VL 7b')
  // ...including the ones the old length rule got right and an acronym list
  // must not lose: GLM and OSS are everyday ids on a LiteLLM proxy.
  assert.equal(formatModelName(m('glm-4.6')), 'GLM 4.6')
  assert.equal(formatModelName(m('gpt-oss-120b')), 'GPT OSS 120b')
})

test('acronyms are matched case-insensitively', () => {
  // The proxy decides the casing of the id it reports; `Gpt-4o` and `GLM-4.6`
  // must read the same as their lowercase spellings.
  assert.equal(formatModelName(m('Gpt-4o')), 'GPT 4o')
  assert.equal(formatModelName(m('zai-org/GLM-4.6')), 'GLM 4.6')
})

test('dots separate id segments but never split a version number', () => {
  // Bedrock/Vertex ids are dot-separated, the same reason `categorizeModel`
  // treats `.` as a token boundary.
  assert.equal(formatModelName(m('amazon.nova-pro-v1:0')), 'Amazon Nova Pro v1:0')
  assert.equal(formatModelName(m('anthropic.claude-sonnet-5')), 'Anthropic Claude Sonnet 5')
  // But a dot between digits is part of one version token, not a separator.
  assert.equal(formatModelName(m('gpt-3.5-turbo')), 'GPT 3.5 Turbo')
  assert.equal(formatModelName(m('imagen-3.0-generate-002')), 'Imagen 3.0 Generate 002')
})

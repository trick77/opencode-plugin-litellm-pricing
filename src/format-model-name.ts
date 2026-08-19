// Display-name formatting and coarse model classification.

import type { LiteLLMModel, ModelType } from './types.ts'
import { LITELLM_CHAT_MODES } from './types.ts'

/**
 * Map a LiteLLM `mode` string to a ModelType.
 *
 * An ALLOW-list, not a deny-list: any non-empty mode that isn't a chat mode is
 * non-chat, including values this file has never heard of. A deny-list
 * silently let new modes (`search`, `image_edit`, …) through as chat models.
 *
 * Shared by both mode sources — the proxy's and the catalog's — so the two can
 * never drift into classifying the same string differently.
 */
function categorizeMode(rawMode: string): ModelType {
  const mode = rawMode.toLowerCase()
  if (LITELLM_CHAT_MODES.has(mode)) return 'chat'
  if (mode === 'embedding') return 'embedding'
  if (mode === 'image_generation') return 'image'
  if (mode === 'audio_transcription' || mode === 'audio_speech') return 'audio'
  // rerank / moderation / search / ocr / video_generation / anything
  // unrecognised → not chat
  return 'unknown'
}

/**
 * Classify a model so non-chat models (embedding, image, audio, rerank,
 * moderation, search) can be filtered out of the picker.
 *
 * Three signals, in descending order of authority:
 *
 * 1. `model.mode` — the proxy's own answer, via /model_group/info. Absent
 *    whenever that endpoint is unreadable, which is the DEFAULT for a key
 *    created with `key_type: "llm_api"`: LiteLLM gives such keys
 *    `allowed_routes: ["llm_api_routes"]`, and /model_group/info sits in
 *    `info_routes`. So this signal is missing on a great many proxies.
 * 2. The id heuristics — narrow, high-precision, and therefore ahead of the
 *    catalog, whose name match may be a substring rather than an exact key.
 * 3. `catalogMode` — the `mode` field of the matched price-table entry. Needs
 *    no key at all, and covers the non-chat models the heuristics cannot name:
 *    image/video generators, OCR, search and realtime endpoints whose ids
 *    carry no recognisable keyword.
 *
 * The id heuristics are deliberately narrow: a false positive HIDES a
 * usable chat model, which is worse than showing a stray non-chat one. So
 * we match only strong, boundary-anchored signals — e.g. `whisper`/`tts`,
 * not a bare `audio` substring (which would wrongly hide a chat model like
 * `gpt-4o-audio-preview`). Deliberately NOT matched for the same reason:
 * bare `nova` (`amazon.nova-pro-v1` is a chat model), `e5`, `gte`.
 */
export function categorizeModel(model: LiteLLMModel, catalogMode?: string): ModelType {
  // `mode` is absent on /v1/models and null for models LiteLLM has no
  // price-map entry for; both mean "no signal", not "not a chat model".
  if (model.mode) return categorizeMode(model.mode)

  // Token boundaries include `.`: Bedrock/Vertex ids are dot-separated
  // (`stability.sd3-large-v1:0`, `amazon.titan-embed-text-v2`), so a class of
  // only `[-_/]` would miss the leading segment of every one of them.
  const id = model.id.toLowerCase()
  if (/rerank/.test(id)) return 'unknown'
  if (/moderat/.test(id)) return 'unknown'
  if (
    /embedding|(?:^|[-_/.])embed(?:$|[-_/.])|(?:^|[-_/.])voyage-|(?:^|[-_/.])bge-|jina-embed|jina-clip/.test(
      id,
    )
  ) {
    return 'embedding'
  }
  if (/whisper|transcrib|(?:^|[-_/.])tts(?:$|[-_/.])|elevenlabs|cartesia|deepgram/.test(id)) {
    return 'audio'
  }
  if (
    // `-image` must end the id or be followed by a version-ish token
    // (`grok-2-image-1212`), never by a word — `…-image-understanding` is a
    // chat model, and a bare `image` substring is far too broad.
    /dall-?e|stable-diffusion|midjourney|(?:^|[-_/.])flux(?:$|[-_/.])|imagen|gpt-image|-image(?:$|[-_/]\d)|(?:^|[-_/.])sd3(?:$|[-_/.])|seedream/.test(
      id,
    )
  ) {
    return 'image'
  }

  // Nothing in the id said non-chat. The catalog is the last real signal
  // before the default — and the only one that survives a key which cannot
  // read /model_group/info.
  if (catalogMode) return categorizeMode(catalogMode)

  return 'chat'
}

/**
 * Tokens rendered in full caps. An explicit list, not a length rule: the old
 * `length <= 3 -> toUpperCase()` shouted every short WORD too, so
 * `gemini-2.5-pro` read as `Gemini 2.5 PRO` next to a correctly-cased `Mini`.
 *
 * Only add genuine acronyms and initialisms here. A word that merely happens
 * to be short (pro, max, air, lite, nano) is title-cased like any other.
 *
 * Listed lowercase; matched case-insensitively, so a proxy that reports
 * `Gpt-4o` still renders `GPT 4o`.
 */
const ACRONYMS: ReadonlySet<string> = new Set([
  'ai',
  'api',
  'glm',
  'gpt',
  'hd',
  'hf',
  'llm',
  'moe',
  'ocr',
  'oss',
  'sd3',
  'tts',
  'ui',
  'vl',
  'xai',
])

/** Case-insensitive membership, so `GLM`/`Glm`/`glm` all shout alike. */
function isAcronym(word: string): boolean {
  return ACRONYMS.has(word.toLowerCase())
}

/**
 * Turn a raw model id into a readable display name. Strips a leading
 * provider prefix (`azure/`, `openai/`, …), splits on separators, and
 * title-cases words while preserving acronyms and versioned tokens.
 */
export function formatModelName(model: LiteLLMModel): string {
  let id = model.id
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)

  // `.` splits too, for the same reason it is a token boundary in
  // `categorizeModel`: Bedrock/Vertex ids are dot-separated, and without it
  // `amazon.nova-pro-v1:0` renders as `Amazon.nova …`. But ONLY when it is not
  // between digits — `gpt-3.5` and `gemini-2.5` are single version tokens, and
  // splitting those would print `GPT 3 5`. `:` is left alone; `v1:0` reads
  // fine as one token.
  const words = id.split(/[-_\s]+|(?<![0-9])\.|\.(?![0-9])/).filter(Boolean)
  const formatted = words.map((word) => {
    // Keep tokens that already carry meaningful casing/digits as-is
    // (e.g. "3.5", "v2", "o1"), only capitalising plain words.
    if (/\d/.test(word) && !isAcronym(word)) return word
    if (isAcronym(word)) return word.toUpperCase()
    return word.charAt(0).toUpperCase() + word.slice(1)
  })
  return formatted.join(' ')
}

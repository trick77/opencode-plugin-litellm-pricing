// A fake opencode V2 host: enough of the real thing to run this plugin end to
// end in a test, without opencode and without a LiteLLM proxy.
//
// Not a test file — `npm test` globs `test/*.test.ts`, so nothing under
// `test/helpers/` is collected as a suite.
//
// Modelled on opencode 2.0.32 (packages/core/src/provider.ts,
// packages/core/src/config/plugin/provider.ts, packages/core/src/plugin/module.ts).
// What is faked, and how it can drift from the real thing:
//
// - The loader: V2 decodes ONLY `mod.default` and requires `{ id: string,
//   setup: function }` (or `effect`). `assertLoadable` checks exactly that.
// - The provider registry: rebuilt on every read by replaying registered
//   transforms in registration order onto a fresh value, seeded from the
//   configured providers — the same fold opencode does. The config provider's
//   own transform is modelled as that seed: it runs before any transform this
//   plugin registers, because the plugin only registers after it has seen the
//   configured provider (see src/plugin.ts).
// - `editor.models.update` seeds a missing model from the real
//   `Model.Info.default`, imported from `@opencode/plugin`, so field defaults
//   cannot drift from opencode's.
// - Events: only what the test emits. Real opencode emits `provider.updated`
//   after any registry change; the plugin's own `reload()` does NOT emit here,
//   so a loop it would cause in production is caught by the fetch count, not
//   by a hang.
//
// CAVEAT: this is a model of opencode 2.0.32, not opencode itself. The real
// load is part of the release checks (AGENTS.md, test/probe/README.md).

import { Model } from '@opencode/plugin'
import type { Plugin, Provider } from '@opencode/plugin'
import type { ProviderEditor, ProviderRecord } from '@opencode/plugin/promise/provider'

// --- the loader -----------------------------------------------------------

/**
 * opencode 2.0.32's `PluginModule.load`: `Schema.decodeUnknownEffect(Module)`
 * over the imported module, where `Module` is `{ default: { id: string,
 * effect: fn } | { id: string, setup: fn } }`. Throws the message opencode
 * reports, so a failure here reads the same as the one a user would see.
 */
export function assertLoadable(mod: Record<string, unknown>): Plugin.Plugin {
  const def = mod.default as Record<string, unknown> | undefined
  if (
    !def ||
    typeof def !== 'object' ||
    typeof def.id !== 'string' ||
    (typeof def.setup !== 'function' && typeof def.effect !== 'function')
  ) {
    throw new Error('Plugin must export a default definition with an id and an effect or setup function.')
  }
  return def as unknown as Plugin.Plugin
}

// --- the registry ---------------------------------------------------------

/** A provider as opencode.json defines it, after V1→V2 normalization. */
export interface ConfiguredProvider {
  id: string
  name?: string
  package?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  /** `providers.<id>.models` — the user's hand-curated entries, by id → name. */
  models?: Record<string, string>
}

export type FoldedRecord = { provider: Provider.Info; models: Map<string, Model.Info> }

export interface FakeHost {
  ctx: Plugin.Context
  /** Replace the configured providers, as a config edit would. */
  configure(providers: ConfiguredProvider[]): void
  /** Deliver an event to every live `event.subscribe` iterator. */
  emit(type: string): void
  /** The registry as the next read would see it. */
  fold(): Map<string, FoldedRecord>
  /** Live transform registrations. */
  readonly transforms: number
  /** Live event subscriptions. */
  readonly subscribers: number
  /** Every `event.subscribe` call so far, live or not. */
  readonly subscriptions: number
  /** End every live event stream normally, as a dropped connection would. */
  endStreams(): void
  /**
   * Injected host failures, consumed one per call: the next N
   * `provider.transform` registrations reject, the next N subscriptions throw
   * on their first read.
   */
  faults: { transform: number; subscribe: number }
  /** Called after each `provider.list()` resolves its value — for timing tests. */
  onList?: () => void
}

/** Build the seed the config provider's transform would produce. */
function seed(providers: ConfiguredProvider[]): Map<string, FoldedRecord> {
  const records = new Map<string, FoldedRecord>()
  for (const p of providers) {
    const provider = {
      id: p.id,
      name: p.name ?? p.id,
      activation: 'enabled',
      package: p.package ?? '',
      ...(p.settings ? { settings: structuredClone(p.settings) } : {}),
      ...(p.headers ? { headers: { ...p.headers } } : {}),
    } as unknown as Provider.Info
    const models = new Map<string, Model.Info>()
    for (const [id, name] of Object.entries(p.models ?? {})) {
      models.set(id, { ...Model.Info.default(p.id as Provider.ID, id as Model.ID), name })
    }
    records.set(p.id, { provider, models })
  }
  return records
}

/** The editor opencode hands a provider transform, over `records`. */
function editorOver(records: Map<string, FoldedRecord>): ProviderEditor {
  const entry = (id: string): FoldedRecord => {
    let record = records.get(id)
    if (!record) {
      record = {
        provider: { id, name: id, activation: 'auto', package: '' } as unknown as Provider.Info,
        models: new Map(),
      }
      records.set(id, record)
    }
    return record
  }
  return {
    list: () => [...records.values()] as unknown as readonly ProviderRecord[],
    get: (id) => records.get(id) as unknown as ProviderRecord | undefined,
    add: () => {
      throw new Error('fake host: the plugin must not replace a provider record with add()')
    },
    update: (id, update) => {
      const record = entry(id)
      update(record.provider as never)
      ;(record.provider as { id: string }).id = id
    },
    remove: (id) => void records.delete(id),
    models: {
      set: () => {
        throw new Error('fake host: the plugin must not replace an inventory with models.set()')
      },
      update: (providerID, modelID, update) => {
        const record = entry(providerID)
        const current = record.models.get(modelID)
        const model = current
          ? structuredClone(current)
          : Model.Info.default(providerID as Provider.ID, modelID as Model.ID)
        update(model as never)
        ;(model as { id: string }).id = modelID
        ;(model as { providerID: string }).providerID = providerID
        record.models.set(modelID, model)
      },
      remove: (providerID, modelID) => void records.get(providerID)?.models.delete(modelID),
    },
  }
}

export function fakeHost(initial: ConfiguredProvider[] = []): FakeHost {
  let configured = initial
  const transforms: Array<(editor: ProviderEditor) => void> = []
  const queues = new Set<{ push: (type: string) => void; close: () => void }>()
  const faults = { transform: 0, subscribe: 0 }
  let subscriptions = 0
  let host: FakeHost

  const fold = () => {
    const records = seed(configured)
    for (const transform of transforms) transform(editorOver(records))
    return records
  }

  const ctx = {
    provider: {
      // `available()` in opencode: every enabled provider, post-fold.
      list: async () => {
        const value = {
          location: { directory: '/fake' },
          data: [...fold().values()].map((r) => r.provider),
        }
        host.onList?.()
        return value
      },
      transform: async (callback: (editor: ProviderEditor) => void) => {
        if (faults.transform > 0) {
          faults.transform--
          throw new Error('fake host: transform registration refused')
        }
        transforms.push(callback)
        return {
          dispose: async () => {
            const i = transforms.indexOf(callback)
            if (i >= 0) transforms.splice(i, 1)
          },
        }
      },
      reload: async () => {},
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
        subscriptions++
        if (faults.subscribe > 0) {
          faults.subscribe--
          return (async function* () {
            throw new Error('fake host: event stream broke')
          })()
        }
        const pending: string[] = []
        let wake: (() => void) | undefined
        let closed = false
        const queue = {
          push: (type: string) => {
            pending.push(type)
            wake?.()
          },
          close: () => {
            closed = true
            queues.delete(queue)
            wake?.()
          },
        }
        queues.add(queue)
        signal?.addEventListener('abort', () => {
          queues.delete(queue)
          queue.close()
        })
        return (async function* () {
          while (!closed) {
            if (pending.length === 0) {
              await new Promise<void>((resolve) => (wake = resolve))
              wake = undefined
              continue
            }
            yield { type: pending.shift()!, data: {} }
          }
        })()
      },
    },
  }

  host = {
    // Everything else on the V2 context is left off and the whole thing cast,
    // so a test fails loudly if the plugin ever reaches for something new.
    ctx: ctx as unknown as Plugin.Context,
    configure: (providers) => {
      configured = providers
    },
    emit: (type) => {
      for (const queue of queues) queue.push(type)
    },
    fold,
    get transforms() {
      return transforms.length
    },
    get subscribers() {
      return queues.size
    },
    get subscriptions() {
      return subscriptions
    },
    endStreams: () => {
      for (const queue of [...queues]) queue.close()
    },
    faults,
  }
  return host
}

// --- the proxy ------------------------------------------------------------

/** A route handler: return a Response, or throw to simulate an unreachable proxy. */
export type Route = (signal?: AbortSignal) => Response | Promise<Response>

/** Keyed by URL pathname, e.g. '/v1/models' or '/v1/model/info'. */
export type Routes = Record<string, Route>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Every request the fake proxy saw during the current `withFakeProxy`, in
 * order. A route that throws is NOT an assertion — the plugin swallows a
 * failed /v1/model/info on purpose — so "this path must not be fetched" has to
 * be checked here rather than left to a throw nobody observes.
 */
export const fetched: Array<{ url: string; headers: Record<string, string> }> = []

/**
 * Swap `globalThis.fetch` for a router over `routes` for the duration of
 * `fn`, and always put the real one back. An unrouted path is a thrown error
 * rather than a 404, so a test that quietly hits the wrong endpoint fails
 * instead of exercising the plugin's "endpoint refused" fallback by accident.
 */
export async function withFakeProxy<T>(routes: Routes, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  fetched.length = 0
  const stub = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    fetched.push({ url: url.href, headers: { ...(init?.headers as Record<string, string>) } })
    const route = routes[url.pathname]
    if (!route) throw new Error(`fake proxy: no route for ${url.pathname}`)
    return route(init?.signal ?? undefined)
  }
  globalThis.fetch = stub as unknown as typeof globalThis.fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

// --- reporting ------------------------------------------------------------

export interface Reported {
  logs: string[]
  warns: string[]
  report: (level: 'info' | 'warn', message: string) => void
}

/** A `report` sink for `setupLiteLLMPricing` that keeps the suite quiet. */
export function reported(): Reported {
  const logs: string[] = []
  const warns: string[] = []
  return {
    logs,
    warns,
    report: (level, message) => void (level === 'warn' ? warns : logs).push(message),
  }
}

// A fake opencode host: enough of the real thing to run this plugin end to
// end in a test, without opencode and without a LiteLLM proxy.
//
// Not a test file — `npm test` globs `test/*.test.ts`, so nothing under
// `test/helpers/` is collected as a suite.
//
// Why this exists: 0.2.0 shipped a plugin that opencode refused to load
// ("Plugin export is not a function") while `tsc` and the whole unit suite
// stayed green. The plugin *function* was fine; the entry module's export
// shape was not, and only opencode's loader loop observes that. A harness
// that imported `LiteLLMPricingPlugin` by name and called it would have
// passed the broken build. So `loadPlugins` below reproduces the loader
// rule instead of approximating it.

import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'

// --- the loader -----------------------------------------------------------

/*
 * Extracted verbatim from the shipped opencode 1.18.6 binary
 * (/opt/homebrew/Cellar/opencode/1.18.6/bin/opencode). `lM` is a typeof
 * check, `ak` normalises an export to a plugin function, `ok` is the loop:
 *
 *   function lM($){return typeof $==="function"}
 *   function ak($){if(lM($))return $;if(!$||typeof $!=="object"||!("server"in $))return;
 *     if(!lM($.server))return;return $.server}
 *   function ok($){let Z=new Set,Q=[];for(let Y of Object.values($)){if(Z.has(Y))continue;
 *     Z.add(Y);let J=ak(Y);if(!J)throw TypeError("Plugin export is not a function");
 *     Q.push(J)}return Q}
 *
 * CAVEAT: this is a model of opencode 1.18.6, not opencode itself. If a
 * future release changes how plugins are loaded, this fake drifts and starts
 * giving false confidence. The minified source above is kept alongside so
 * the drift is auditable — re-extract it with:
 *
 *   strings -a "$(readlink -f "$(which opencode)")" \
 *     | grep -o '.\{700\}Plugin export is not a function.\{200\}'
 *
 * Loading the plugin in a real opencode remains part of the release checks.
 */

/** opencode's `ak`: a plugin export is a function, or an object with `.server`. */
function asPluginFunction(value: unknown): Plugin | undefined {
  if (typeof value === 'function') return value as Plugin
  if (!value || typeof value !== 'object' || !('server' in value)) return undefined
  const server = (value as { server: unknown }).server
  if (typeof server !== 'function') return undefined
  return server as Plugin
}

/**
 * opencode's `ok`: every runtime export of the entry module must be a plugin
 * function. Throws exactly what opencode throws, so a failure here reads the
 * same as the failure a user reports.
 */
export function loadPlugins(mod: object): Plugin[] {
  const seen = new Set<unknown>()
  const plugins: Plugin[] = []
  for (const value of Object.values(mod)) {
    if (seen.has(value)) continue
    seen.add(value)
    const fn = asPluginFunction(value)
    if (!fn) throw new TypeError('Plugin export is not a function')
    plugins.push(fn)
  }
  return plugins
}

// --- the plugin input -----------------------------------------------------

/**
 * The price table as models.dev actually publishes it: an object keyed by
 * provider id, with capabilities and cache costs FLAT (`tool_call`,
 * `cost.cache_read`, `modalities.input` as a string array). opencode's own
 * provider list nests the same information, so the two fixtures together prove
 * `toCatalogFields` reads both.
 */
export const MODELS_DEV_TABLE = {
  azure: {
    id: 'azure',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          tiers: [{ input: 5, output: 22.5, cache_read: 0.5, tier: { type: 'context', size: 272000 } }],
        },
        limit: { context: 1050000, input: 922000, output: 128000 },
        reasoning: true,
        tool_call: true,
        attachment: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
    },
  },
}

/**
 * Write a cache file the plugin will find, aged as asked.
 *
 * `load()` picks its source by cache age, so a scenario that means to exercise
 * the fresh- or stale-cache branch has to put one there — otherwise it silently
 * falls through to the shipped snapshot and asserts nothing about caching.
 * Mirrors the envelope written by `writeCache` in src/catalog.ts; keep `v` in
 * step with CACHE_SCHEMA.
 */
export async function seedCache(providers: unknown[], ageMs: number, v = 1): Promise<void> {
  const dir = join(process.env.XDG_CACHE_HOME!, 'opencode-plugin-litellm-pricing')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'models-dev.json')
  await writeFile(file, JSON.stringify({ v, providers }), 'utf8')
  const when = new Date(Date.now() - ageMs)
  await utimes(file, when, when)
}

/** Every `client.app.log` body the plugin wrote, in order. */
export interface LoggedEntry {
  service: string
  level: string
  message: string
}

/**
 * The members this plugin touches are `client.provider.list({})` and
 * `client.config.providers({})` — see
 * `load()` in src/catalog.ts — and `client.app.log({...})`, the only path into
 * opencode's own log file. Everything else on PluginInput is left off and the
 * whole thing cast, so a test fails loudly if the plugin ever starts reaching
 * for something new rather than silently reading `undefined`.
 *
 * Note this stub cannot verify the *shape* of the app.log call: it is
 * hand-written, so it matches whatever the plugin does. `tsc --noEmit` against
 * the real SDK types is what guards that.
 */
export function fakePluginInput(
  providers: unknown[],
  opts: {
    logged?: LoggedEntry[]
    logFails?: boolean
    /** What /provider serves. Omit to serve the same list as config.providers. */
    all?: unknown[]
    /** Drop /provider entirely, as an older opencode would. */
    noProviderList?: boolean
  } = {},
): PluginInput {
  const provider = opts.noProviderList
    ? undefined
    : { list: async () => ({ data: { all: opts.all ?? providers } }) }
  return {
    client: {
      provider,
      config: {
        providers: async () => ({ data: { providers } }),
      },
      app: {
        log: async (options: { body: LoggedEntry }) => {
          if (opts.logFails) throw new Error('log endpoint unavailable')
          opts.logged?.push(options.body)
          return {}
        },
      },
    },
  } as unknown as PluginInput
}

/**
 * A models.dev-shaped catalog slice, matching the fixture already proven
 * against `buildFromProviders` in catalog.test.ts. `gpt-5.4` is the model the
 * scenarios price against.
 */
export const CATALOG_PROVIDERS = [
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
    },
  },
]

// --- the proxy ------------------------------------------------------------

/** A route handler: return a Response, or throw to simulate an unreachable proxy. */
export type Route = () => Response | Promise<Response>

/** Keyed by URL pathname, e.g. '/v1/models' or '/model_group/info'. */
export type Routes = Record<string, Route>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Every URL the fake proxy was asked for during the current `withFakeProxy`,
 * in order. A route that throws is NOT an assertion — `refreshInBackground`
 * swallows its own failures, so "this path must not hit the network" has to be
 * checked here rather than left to a throw nobody observes.
 */
export const fetchedURLs: string[] = []

/**
 * Swap `globalThis.fetch` for a router over `routes` for the duration of
 * `fn`, and always put the real one back. An unrouted path is a thrown error
 * rather than a 404, so a test that quietly hits the wrong endpoint fails
 * instead of exercising the plugin's "endpoint refused" fallback by accident.
 */
export async function withFakeProxy<T>(routes: Routes, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  fetchedURLs.length = 0
  const stub = async (input: unknown): Promise<Response> => {
    const url = new URL(String(input))
    fetchedURLs.push(url.href)
    // The price table is fetched from models.dev, not from the proxy — see
    // load() in src/catalog.ts. Scenarios that don't care get the default
    // table; one that does can override the route.
    const route = routes[url.pathname] ?? (url.host === 'models.dev' ? modelsDev : undefined)
    if (!route) throw new Error(`fake proxy: no route for ${url.pathname}`)
    return route()
  }
  const modelsDev = () => json(MODELS_DEV_TABLE)
  globalThis.fetch = stub as unknown as typeof globalThis.fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

// --- console --------------------------------------------------------------

export interface Captured<T> {
  result: T
  logs: string[]
  warns: string[]
}

/**
 * Capture what the plugin reports at startup — its summary line is a
 * documented diagnostic, so it is worth asserting — and keep the suite quiet.
 */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const logs: string[] = []
  const warns: string[] = []
  const realLog = console.log
  const realWarn = console.warn
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '))
  try {
    return { result: await fn(), logs, warns }
  } finally {
    console.log = realLog
    console.warn = realWarn
  }
}

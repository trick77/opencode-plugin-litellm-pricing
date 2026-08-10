// The pricing source.
//
// Cost is taken from the models.dev price table, matched to the LiteLLM model
// by name. See load() for why it is not read from opencode's own copy: doing so
// deadlocks plugin startup, and its list only covers providers the reader
// happens to have configured.
//
// The table comes from disk — a week-long cache, falling back to a snapshot
// shipped in the package — and never from a fetch the user is waiting on. See
// load() for that ordering; it is the difference between instant startup and a
// multi-second stall on a slow network.
//
// LiteLLM's own per-model prices are deliberately not used: they depend on the
// deployment having base_model set correctly, which is easy to get wrong and
// then silently bills $0. Name-matching gives the same answer for every key,
// through one code path.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import type { CostBlock, CostTier } from "./types.ts";
import { MODELS_DEV_SNAPSHOT } from "./models-dev-snapshot.ts";

/**
 * The shipped snapshot, swappable for tests.
 *
 * With a real snapshot present the "no price table at all" path in load() is
 * unreachable — which is the point, but it also means the code that explains
 * that failure to the user would never be exercised. Tests blank this to reach
 * it. Nothing else writes to it.
 */
let snapshotTable: unknown = MODELS_DEV_SNAPSHOT;

/** Replace the shipped snapshot — used by tests. */
export function setSnapshotForTests(value: unknown): void {
  snapshotTable = value;
}

type Client = PluginInput["client"];

// Providers we match against, in precedence order. These LiteLLM
// deployments are Azure/OpenAI; both carry the full model line in models.dev
// and price it identically, so Azure is preferred with OpenAI as an
// equivalent fallback. Restricting to these two avoids false matches against
// third-party aggregators that use slash-laden ids.
const PREFERRED_PROVIDERS = ["azure", "openai"];

/** The opencode-config fields we can source from a catalog model. */
export interface CatalogFields {
  cost?: CostBlock;
  limit?: { context: number; output: number };
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  modalities?: { input: string[]; output: string[] };
}

export interface Catalog {
  /** Resolve a LiteLLM model name to catalog fields, or null if unmatched. */
  resolve(litellmModelName: string): CatalogFields | null;
  /** How many priceable models the catalog was built from. */
  readonly candidateCount: number;
  /** Which of PREFERRED_PROVIDERS actually contributed candidates. */
  readonly matchedProviders: readonly string[];
}

/**
 * Why pricing did or did not happen. `getCatalog` returns `null` for both "the
 * load failed" and "the response had nothing usable", and `resolve` returns
 * `null` for both "no catalog" and "no name match" — so without this, a run
 * that prices nothing is indistinguishable from a run with nothing to price.
 */
export interface CatalogStatus {
  /** 'loading' until the load settles — never a verdict, just "not yet". */
  state: "loading" | "ok" | "unavailable";
  /** Which endpoint answered. */
  source?: string;
  /** Populated when state is 'unavailable'. */
  reason?: string;
  candidateCount?: number;
  matchedProviders?: readonly string[];
  elapsedMs?: number;
}

interface Candidate {
  id: string; // lowercased models.dev id, e.g. "gpt-5.4-mini"
  fields: CatalogFields;
}

/**
 * Bound on the models.dev fetch. Nothing on the startup path waits for it any
 * more — it applies to the background refresh, and to the unreachable
 * last-resort branch in load(). Short on purpose: a refresh that misses this
 * window simply happens next launch.
 */
const CATALOG_TIMEOUT_MS = 3_000;

let catalogPromise: Promise<Catalog | null> | undefined;
let catalogStatus: CatalogStatus = { state: "loading" };
let readyCatalog: Catalog | null = null;

/** What happened on the (single) catalog load. Safe to call before it runs. */
export function getCatalogStatus(): CatalogStatus {
  return catalogStatus;
}

/** Load opencode's model catalog once per process (memoized). */
export function getCatalog(client: Client): Promise<Catalog | null> {
  if (!catalogPromise) {
    catalogPromise = load(client);
    // A promise cannot be inspected synchronously, so latch the result for
    // catalogIfReady().
    void catalogPromise.then((c) => {
      readyCatalog = c;
    });
  }
  return catalogPromise;
}

/**
 * Load the catalog before the `config` hook runs. Never throws.
 *
 * Awaited, and safe to await: the fetch goes to models.dev, not to the opencode
 * server that is loading this plugin. Awaiting the latter is what deadlocked.
 * It has to finish first, because the hook is invoked exactly once — there is
 * no second pass to fill prices in on.
 */
export async function preloadCatalog(client: Client): Promise<void> {
  await getCatalog(client);
}

/** The catalog if loaded, else null. */
export function catalogIfReady(): Catalog | null {
  return readyCatalog;
}

/** Clear the memoized catalog — used by tests. */
export function resetCatalogCache(): void {
  catalogPromise = undefined;
  catalogStatus = { state: "loading" };
  readyCatalog = null;
}

/** models.dev's published price table. */
const MODELS_DEV_URL = "https://models.dev/api.json";

/** Where the last good copy is kept, so a cold start still prices offline. */
function cachePath(): string {
  const base =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache");
  return join(base, "opencode-plugin-litellm-pricing", "models-dev.json");
}

/**
 * Serve the cache without re-fetching for this long. A week: these are public
 * list prices, which move on the scale of provider announcements, and a refresh
 * happens in the background anyway so nobody waits for one.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bump whenever the trimmed shape changes — including any change to
 * PREFERRED_PROVIDERS or to the fields toCatalogFields reads. The cache stores
 * a subset, so a stale layout would otherwise be served forever as if complete:
 * a widened provider list would silently keep pricing nothing from the new
 * provider. On a mismatch the cache is discarded and refetched.
 */
const CACHE_SCHEMA = 1;

/**
 * models.dev ships its table as an object keyed by provider id; buildFromProviders
 * wants a list. `id` is already on each entry, but default it from the key so an
 * entry without one still lands under the right provider.
 */
function toProviderList(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.entries(raw as Record<string, Record<string, unknown>>).map(
    ([id, p]) => ({
      ...p,
      id: typeof p?.id === "string" ? p.id : id,
    }),
  );
}

/**
 * The fields toCatalogFields/toCost read, and nothing else. models.dev publishes
 * 3.6 MB; restricted to PREFERRED_PROVIDERS and these keys it is ~34 KB, which
 * is what makes it cheap to re-read on every single start.
 *
 * Keep in step with scripts/update-snapshot.mjs, which trims the shipped
 * snapshot the same way — and bump CACHE_SCHEMA when this list changes.
 */
const KEEP_FIELDS = [
  "id",
  "cost",
  "limit",
  "reasoning",
  "tool_call",
  "attachment",
  "modalities",
];

/** Trim a provider list (already through toProviderList) for storage. */
function trim(providers: unknown[]): unknown[] {
  // Providers too, not just fields: the matcher only ever looks at
  // PREFERRED_PROVIDERS, so storing the other 180 costs ~1.6 MB of parsing on
  // every start to hold data nothing reads. This is the difference between a
  // 34 KB cache and a 1.6 MB one.
  const wanted = new Set<string>(PREFERRED_PROVIDERS);
  return providers
    .filter((raw) => wanted.has(String((raw as { id?: unknown }).id)))
    .map((raw) => {
      const p = raw as { id?: unknown; models?: unknown };
      const models: Record<string, unknown> = {};
      for (const [key, m] of Object.entries(
        (p.models ?? {}) as Record<string, unknown>,
      )) {
        const model = (m ?? {}) as Record<string, unknown>;
        const kept: Record<string, unknown> = {};
        for (const field of KEEP_FIELDS)
          if (field in model) kept[field] = model[field];
        models[key] = kept;
      }
      return { id: p.id, models };
    });
}

/**
 * Read the cached table.
 *
 * Note the shape difference that makes this NOT symmetric with the snapshot:
 * the cache envelope stores an ARRAY, already through toProviderList, whereas
 * the snapshot ships models.dev's object map and still needs converting. Mixing
 * the two yields zero candidates and a fetch on every start — fast enough that
 * tests still pass while the cache has silently stopped working.
 */
async function readCache(): Promise<{
  providers: unknown[];
  ageMs: number;
} | null> {
  try {
    const path = cachePath();
    const [text, info] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    const envelope = JSON.parse(text) as { v?: unknown; providers?: unknown };
    if (envelope?.v !== CACHE_SCHEMA || !Array.isArray(envelope.providers))
      return null;
    return { providers: envelope.providers, ageMs: Date.now() - info.mtimeMs };
  } catch {
    return null;
  }
}

async function writeCache(providers: unknown[]): Promise<void> {
  const text = JSON.stringify({ v: CACHE_SCHEMA, providers: trim(providers) });
  const path = cachePath();
  // Write-then-rename, pid-scoped: two opencode processes starting at once
  // would otherwise interleave into a truncated file that never parses again
  // until the next successful fetch. rename() is atomic within a filesystem.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch {
    // A cache we cannot write is not a reason to fail the load.
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Build a catalog from a provider list, or null if nothing in it is priceable. */
function catalogFrom(providers: unknown[]): Catalog | null {
  const catalog = buildFromProviders(providers);
  return catalog.candidateCount > 0 ? catalog : null;
}

function ok(catalog: Catalog, source: string, t0: number): Catalog {
  catalogStatus = {
    state: "ok",
    source,
    elapsedMs: Date.now() - t0,
    candidateCount: catalog.candidateCount,
    matchedProviders: catalog.matchedProviders,
  };
  return catalog;
}

/**
 * Load the price table.
 *
 * Fetched from models.dev directly rather than through opencode's client. That
 * is not a preference. opencode's server cannot answer a request while a plugin
 * is blocked waiting on it, so awaiting its provider list during plugin load
 * deadlocks — measured at 60 s for both `provider.list` and `config.providers`,
 * while the identical call left unawaited returned in 351 ms, right after the
 * `config` hook had already run. And that hook is invoked exactly once, under
 * `serve` and the CLI alike, so there is no later pass to price into. An
 * ordinary HTTPS fetch has no such dependency and can simply be awaited.
 *
 * models.dev is also the more correct source: it carries every provider,
 * whereas `config.providers` carries only the ones the reader has configured. A
 * machine with no Azure credentials has no `azure` entry at all, and the
 * `openai` entry it does have reports every cost as 0 — pricing from that would
 * report $0 by accident of the reader's config, the exact failure this plugin
 * exists to prevent.
 */
/** Fetch the live table and cache it. Throws; callers decide whether to care. */
async function fetchTable(): Promise<unknown[]> {
  const res = await fetch(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const providers = toProviderList(JSON.parse(await res.text()));
  if (!providers) throw new Error("unexpected response shape");
  await writeCache(providers);
  return providers;
}

/**
 * Refresh for the NEXT launch, without anybody waiting for it.
 *
 * Safe to leave running: opencode does not wait on the event loop before
 * exiting — measured, a short CLI invocation exited 216 ms in with a
 * deliberately black-holed 3 s fetch still pending. So this either finishes in
 * a long-lived session and updates the cache, or the process ends first and the
 * next launch tries again. Neither delays anything.
 *
 * It must swallow its own failure: nothing observes this promise, and an
 * unhandled rejection would take the process down.
 */
function refreshInBackground(): void {
  void fetchTable().catch(() => {});
}

async function load(_client: Client): Promise<Catalog | null> {
  const t0 = Date.now();

  // Order matters, and the rule is: NEVER await the network to answer this.
  // The `config` hook runs once, so this call sits directly in front of
  // startup; a fetch here is a stall the user watches. Every branch below
  // answers from something already on disk or in the package, and demotes the
  // fetch to a background top-up for next time.
  const cached = await readCache();

  // 1. A fresh cache is authoritative — no network at all.
  if (cached && cached.ageMs < CACHE_TTL_MS) {
    const catalog = catalogFrom(cached.providers);
    if (catalog) return ok(catalog, "cache", t0);
  }

  // 2. A stale cache is still the right answer NOW. Week-old list prices beat
  //    making someone wait, so serve them and refresh behind their back.
  if (cached) {
    const catalog = catalogFrom(cached.providers);
    if (catalog) {
      refreshInBackground();
      return ok(catalog, "stale cache (refreshing)", t0);
    }
  }

  // 3. No usable cache — a fresh install, or one that was cleared. The shipped
  //    snapshot covers it, so even this case costs nothing.
  const snapshot = toProviderList(snapshotTable);
  const fromSnapshot = snapshot && catalogFrom(snapshot);
  if (fromSnapshot) {
    refreshInBackground();
    return ok(fromSnapshot, "snapshot (refreshing)", t0);
  }

  // 4. Only if the shipped snapshot is itself unusable, which should not be
  //    reachable — it is generated and asserted non-empty at build time. Kept
  //    so a corrupted package degrades to a bounded wait instead of no prices.
  try {
    const providers = await fetchTable();
    const catalog = catalogFrom(providers);
    if (!catalog) throw new Error("no priceable providers");
    return ok(catalog, MODELS_DEV_URL, t0);
  } catch (err) {
    catalogStatus = {
      state: "unavailable",
      source: MODELS_DEV_URL,
      reason: `${err instanceof Error ? err.message : String(err)} after ${Date.now() - t0}ms`,
    };
    return null;
  }
}

/**
 * Build a name resolver from a list of opencode provider objects. Pure and
 * exported for testing.
 */
export function buildFromProviders(providers: unknown[]): Catalog {
  const byId = new Map<string, Record<string, unknown>>();
  for (const p of providers) {
    if (
      p &&
      typeof p === "object" &&
      typeof (p as { id?: unknown }).id === "string"
    ) {
      byId.set((p as { id: string }).id, p as Record<string, unknown>);
    }
  }

  // Candidates in provider-precedence order, then sorted longest id first so
  // the first substring match is the most specific (…-mini beats base) and,
  // on a length tie, comes from the preferred provider (stable sort).
  const candidates: Candidate[] = [];
  const matched: string[] = [];
  for (const provider of PREFERRED_PROVIDERS) {
    const models = byId.get(provider)?.models;
    if (!models || typeof models !== "object") continue;
    matched.push(provider);
    for (const [key, raw] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const m = (raw ?? {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : key;
      candidates.push({ id: id.toLowerCase(), fields: toCatalogFields(m) });
    }
  }
  candidates.sort((a, b) => b.id.length - a.id.length);

  return {
    candidateCount: candidates.length,
    matchedProviders: matched,
    resolve(litellmModelName: string): CatalogFields | null {
      const norm = litellmModelName.toLowerCase();
      for (const c of candidates) {
        if (isBoundedSubstring(norm, c.id)) return c.fields;
      }
      return null;
    },
  };
}

/**
 * True if `needle` occurs in `haystack` not flanked by an alphanumeric
 * char, so "gpt-5.4" matches "ai-gateway-gpt-5.4" and "…gpt-5.4-mini" but
 * NOT "…gpt-5.45".
 */
function isBoundedSubstring(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return false;
    const before = i === 0 ? "" : haystack[i - 1]!;
    const after = haystack[i + needle.length] ?? "";
    if (!isAlnum(before) && !isAlnum(after)) return true;
    from = i + 1;
  }
}

function isAlnum(ch: string): boolean {
  return ch !== "" && /[a-z0-9]/.test(ch);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Map an opencode catalog model (models.dev V2 shape) to config fields. */
function toCatalogFields(m: Record<string, unknown>): CatalogFields {
  const fields: CatalogFields = {};

  const cost = toCost(m.cost);
  if (cost) fields.cost = cost;

  const limit = m.limit as { context?: unknown; output?: unknown } | undefined;
  const context = num(limit?.context);
  const output = num(limit?.output);
  if (context != null && output != null) fields.limit = { context, output };

  // Two shapes in play. models.dev publishes capabilities flat
  // (`tool_call`, `modalities.input: string[]`); opencode's own provider list
  // nests them (`capabilities.toolcall`, `capabilities.input` as booleans).
  // Read either, because a field read off the wrong shape yields undefined and
  // silently drops the capability.
  const caps = m.capabilities as Record<string, unknown> | undefined;
  if (caps?.reasoning === true || m.reasoning === true) fields.reasoning = true;
  if (caps?.toolcall === true || m.tool_call === true) fields.tool_call = true;
  if (caps?.attachment === true || m.attachment === true)
    fields.attachment = true;

  const flatModalities = m.modalities as
    { input?: unknown; output?: unknown } | undefined;
  const modalities = Array.isArray(flatModalities?.input)
    ? {
        input: flatModalities.input.filter(
          (x): x is string => typeof x === "string",
        ),
        output: Array.isArray(flatModalities.output)
          ? flatModalities.output.filter(
              (x): x is string => typeof x === "string",
            )
          : ["text"],
      }
    : toModalities(caps?.input as Record<string, unknown> | undefined);
  if (modalities) fields.modalities = modalities;

  return fields;
}

// models.dev costs (as opencode exposes them) are already USD per 1M tokens,
// so they map straight through — no ×1e6 scaling.
function toCost(raw: unknown): CostBlock | undefined {
  const cost = raw as
    | {
        input?: unknown;
        output?: unknown;
        cache?: { read?: unknown; write?: unknown };
        cache_read?: unknown;
        cache_write?: unknown;
        tiers?: unknown;
        context_over_200k?: unknown;
        experimentalOver200K?: unknown;
      }
    | undefined;
  const input = num(cost?.input);
  const output = num(cost?.output);
  if (input == null || output == null) return undefined;

  const block: CostBlock = { input, output };
  // Flat (`cache_read`, models.dev) or nested (`cache.read`, opencode).
  const cacheRead = num(cost?.cache?.read) ?? num(cost?.cache_read);
  const cacheWrite = num(cost?.cache?.write) ?? num(cost?.cache_write);
  if (cacheRead) block.cache_read = cacheRead;
  if (cacheWrite) block.cache_write = cacheWrite;

  // The over-200k tier is `experimentalOver200K` in opencode's list and
  // `cost.context_over_200k` in models.dev's. models.dev also publishes a
  // `cost.tiers[]` array, but its first entry is NOT necessarily the 200k
  // band — thresholds range from 16k to 512k, and models.dev omits
  // `context_over_200k` precisely when no tier reaches 200k. Reading tiers[0]
  // blind would label a 32k-band price as the over-200k price. Fall back to it
  // only when its own threshold says it qualifies.
  const tiers = Array.isArray(cost?.tiers) ? cost.tiers : [];
  const firstTierSize = num(
    (tiers[0] as { tier?: { size?: unknown } } | undefined)?.tier?.size,
  );
  const tierFallback =
    firstTierSize != null && firstTierSize >= 200_000 ? tiers[0] : undefined;
  const over = (cost?.experimentalOver200K ??
    cost?.context_over_200k ??
    tierFallback) as
    | {
        input?: unknown;
        output?: unknown;
        cache?: { read?: unknown; write?: unknown };
        cache_read?: unknown;
        cache_write?: unknown;
      }
    | undefined;
  const overIn = num(over?.input);
  const overOut = num(over?.output);
  if (overIn != null && overOut != null) {
    const tier: CostTier = { input: overIn, output: overOut };
    const tr = num(over?.cache?.read) ?? num(over?.cache_read);
    const tw = num(over?.cache?.write) ?? num(over?.cache_write);
    if (tr) tier.cache_read = tr;
    if (tw) tier.cache_write = tw;
    block.context_over_200k = tier;
  }
  return block;
}

function toModalities(
  input: Record<string, unknown> | undefined,
): { input: string[]; output: string[] } | undefined {
  if (!input) return undefined;
  const mods: string[] = ["text"];
  if (input.image === true) mods.push("image");
  if (input.audio === true) mods.push("audio");
  if (input.pdf === true) mods.push("pdf");
  if (input.video === true) mods.push("video");
  if (mods.length <= 1) return undefined;
  return { input: mods, output: ["text"] };
}

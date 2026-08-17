# AGENTS.md

OpenCode plugin that injects per-model **cost** for LiteLLM proxy models.

## Build / test

- `npm run build` → `tsc --noEmit` (typecheck only; no `dist`).
- `npm test` → typecheck + `node --test test/*.test.ts`. Node 22+.
- Ships raw TS: `main` is `src/index.ts` (OpenCode/bun runs it). Every relative
  import MUST carry a `.ts` extension (`./types.ts`) — enabled by
  `allowImportingTsExtensions`. Extensionless imports break the node test runner.
- Entry module `src/index.ts`: EVERY runtime export must be a plugin function.
  OpenCode's loader iterates `Object.values(mod)` and throws "Plugin export is
  not a function" on anything else. Re-export types with `export type *`, NEVER
  `export *` — a leaked value (`LITELLM_CHAT_MODES`) broke 0.2.0, invisible to
  `tsc` and to every unit test.
- `test/opencode-host.test.ts` runs the plugin through a fake OpenCode loader +
  stubbed proxy (`test/helpers/fake-opencode-host.ts`, modelled on opencode
  1.18.6). Change loader/hook behaviour → update it. Give each scenario its OWN
  baseURL: `injectedModelIds` is unreset module state, so a shared URL sends the
  second scenario down the early-return, passing having done nothing. Helpers in
  `test/helpers/` so the `test/*.test.ts` glob skips them. The suite points
  `XDG_CACHE_HOME` at a temp dir — keep it that way or it reads your real cache.
- Harness runs on NODE; OpenCode runs BUN. Touching `src/index.ts` exports or
  anything transpiler-sensitive → also load for real: scratch dir with
  `"plugin": ["file:///<abs-path-to-checkout>"]` (no LiteLLM provider needed),
  `opencode models --print-logs`, confirm no `failed to load plugin`. Never
  `--pure` — skips external plugins.

## The probe — USE IT for anything startup-related

`npm test` calls the `config` hook directly → blind to startup: catalog load,
hook invocation count, client-call timing, prices reaching the picker. Use
`test/probe/` (its README has the commands): `node test/probe/fake-proxy.mjs`,
then `cd test/probe && opencode models`.

- `config` hook invoked EXACTLY ONCE (verified: `serve` + CLI). Never design
  around "a later pass fixes it up".
- NEVER await an opencode client call during plugin load — server can't answer
  while a plugin blocks it. Awaited `config.providers`/`provider.list` timed out
  at 60s; unawaited returned in 351ms, after the hook ran. Cost every price.
- Ground truth = `/config/providers`, not stdout. A log line proves code ran,
  not that the price reached the picker.

## Cost mapping — load-bearing rules

- OpenCode config `cost` is FLAT and closed:
  `{ input, output, cache_read, cache_write, context_over_200k }`,
  `additionalProperties:false`. NEVER emit a nested `cache` object — the schema
  rejects it and the whole `cost` is dropped. Values are USD per 1M tokens.
- ONE cost source: the configured price table, in LiteLLM
  `model_prices_and_context_window.json` format (`options.catalogURL`, NO
  default — unset means inject unpriced + warn). Costs are per-TOKEN — they MUST go through
  `buildCost`/`perMillion` (×1e6). Never source cost from the proxy —
  `/v1/model/info` needs an admin key, which a normal virtual key is not.
- NEVER await a fetch on the startup path once a cache exists. The `config`
  hook runs once, before anything renders, so a fetch there is a stall the user
  sits through. `load()` answers from cache (7d) → stale cache (background
  refresh) → fetch. That last branch is the FIRST start only: nothing ships in
  the package, and the hook has no second pass, so an unpriced injection there
  stays unpriced all session. Background refresh must `.catch()` — nothing
  observes it, and an unhandled rejection kills the process. Safe to leave
  pending: opencode exits without draining the event loop (measured: CLI exited
  216ms in with a black-holed 3s fetch outstanding), so it lands in long
  sessions and is simply skipped in short ones.
- NEVER ship a price table in the package. It goes stale between releases and
  bloats the install; the cache is the only local copy. Bump `CACHE_SCHEMA`
  when `KEEP_FIELDS` changes, else old caches are served as if complete.
- The cache file is keyed by a hash of the price-table URL. Two providers on
  two tables must never read each other's prices.
- NEVER filter the table by provider when trimming/caching. Only the SUBSTRING
  pass is restricted to `azure`/`openai`; the exact-key pass sees everything,
  and a provider filter would strip out precisely the enriched entries a custom
  table exists to provide.
- Pin prices against fixtures only (`PRICE_TABLE`), seeded via the harness
  `seed` option or served by the fake proxy — never against live upstream data.
- NEVER go back to `client.config.providers()` for cost: deadlocks (above), and
  lists only the reader's configured providers — no Azure creds → no `azure`,
  and its `openai` entry reports every cost as 0 → real models priced $0.
- One table shape: flat, keyed by model name, `litellm_provider` inside the
  entry, costs per TOKEN. Skip the `sample_spec` key — it is a doc stub.
- Emit `cost` only when both `input` and `output` are known. Keep a real `0`
  (free tier); drop only absent values.
- EXCEPTION, table path only (`toCatalogFields`): a cost that is zero across
  the board is the table saying "no number", not "free" — upstream ships 124
  such entries, some plainly billable. Drop the whole `cost`; the model is
  injected unpriced and named in the log. Do NOT move this into `buildCost`.
- Tiering: map LiteLLM `*_above_200k_tokens` → `context_over_200k`. Do NOT map
  `*_above_272k_tokens` (would overcharge the 200k–272k band).

## LiteLLM field semantics

- `max_input_tokens` = context window. `max_tokens` = legacy alias of max
  OUTPUT, not context. Never use `max_tokens` for `limit.context`.
- Azure / custom deployments need `model_info.base_model` set, else LiteLLM
  bills $0 and there is no cost to surface.

## Discovery rules

- `options.baseURL` is REQUIRED. No default URL, no port probing, never
  localhost. Missing → warn and skip the provider.
- `/v1/models` carries NO `mode` (shape: `id/object/created/owned_by`). `mode`
  comes from `/model_group/info`, keyed by `model_group` = the `/v1/models`
  id. Best-effort, 3s budget: ANY failure falls back to the id heuristics in
  `categorizeModel`. Never let it block, throw, or drop models — it is not
  settled whether that endpoint needs an elevated key.
- `mode` branch is an ALLOW-list (`chat`/`completion`/`responses`); any other
  non-empty mode is non-chat. `null`/absent → fall through to heuristics.
  LiteLLM really does emit `mode: null`.
- Id heuristics stay narrow — a false positive HIDES a working chat model.
  Never match bare `nova` / `e5` / `gte` / `audio`.
- Never overwrite a user-curated `provider.*.models` entry.
- Provider ids matched: `opencode-plugin-litellm-pricing` (package name),
  `opencode-litellm-pricing` (pre-0.3.0 name — user config, never drop it),
  `litellm`, `litellm-*`/`litellm_*`, `options.litellm*` flags.
- Report via `report()` in `plugin.ts` → console AND `client.app.log`. console
  alone never reaches `~/.local/share/opencode/log/opencode.log`. Never await
  that log call; never let it break config loading.
- Fail soft: warn and continue; never throw out of the `config` hook. Skip
  malformed entries and wildcard (`*`) ids.
- Name match: EXACT table key first (case-insensitive, any provider), then
  bounded substring — longest-match, boundary-anchored, leading `<provider>/`
  stripped, providers `azure` then `openai` only.

## Release

- Tag-driven. Bump `version` in `package.json`, push `vX.Y.Z` (must match). CI
  publishes to npm via OIDC trusted publishing. Do not `npm publish` by hand.
- Tag on `master` AFTER merge — the workflow publishes whatever commit the tag
  points at, so tagging a branch ships unmerged code.
- Released → update `../opencode-presets/presets/plugin-litellm-pricing.conf`:
  `@pins`, `@description` (names the package), the body spec string, and bump
  that preset's own `@version`.

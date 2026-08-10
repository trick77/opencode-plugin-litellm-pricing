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
- ONE cost source: `https://models.dev/api.json`, fetched directly, cached 24h
  under `$XDG_CACHE_HOME/opencode-plugin-litellm-pricing/`. Costs ALREADY
  per-1M — copy through, do NOT ×1e6. Never source cost from the proxy
  (base_model misconfig silently bills $0).
- NEVER go back to `client.config.providers()` for cost: deadlocks (above), and
  lists only the reader's configured providers — no Azure creds → no `azure`,
  and its `openai` entry reports every cost as 0 → real models priced $0.
- Both catalog shapes must parse. models.dev FLAT (`tool_call`,
  `cost.cache_read`, `cost.tiers[]`, `modalities.input: string[]`); opencode
  provider list NESTED (`capabilities.toolcall`, `cost.cache.read`,
  `experimentalOver200K`). Wrong shape → `undefined` → price silently dropped.
- `perMillion` (per-TOKEN → ×1e6, round 6dp) applies only to the unused
  `/v1/model/info` reader. Do not wire it into the live path.
- Emit `cost` only when both `input` and `output` are known. Keep a real `0`
  (free tier); drop only absent values.
- Tiering: map LiteLLM `*_above_200k_tokens` → `context_over_200k`. Do NOT map
  `*_above_272k_tokens` (would overcharge the 200k–272k band). models.dev path
  maps `experimentalOver200K`, else the first `cost.tiers[]` entry.

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
- models.dev name match: longest-match, boundary-anchored, providers `azure`
  then `openai` only.

## Release

- Tag-driven. Bump `version` in `package.json`, push `vX.Y.Z` (must match). CI
  publishes to npm via OIDC trusted publishing. Do not `npm publish` by hand.
- Tag on `master` AFTER merge — the workflow publishes whatever commit the tag
  points at, so tagging a branch ships unmerged code.
- Released → update `../opencode-presets/presets/plugin-litellm-pricing.conf`:
  `@pins`, `@description` (names the package), the body spec string, and bump
  that preset's own `@version`.

# AGENTS.md

OpenCode **2** plugin (V2 API, `@opencode/plugin`) that injects per-model
**cost** for LiteLLM proxy models. V1 support dropped at 1.0.0 (0.9.0 = last V1).

## Build / test

- `npm run build` → `tsc --noEmit` (typecheck only; no `dist`).
- `npm test` → typecheck + `node --test test/*.test.ts`. Node 22+.
- Ships raw TS: `main` is `src/index.ts` (OpenCode/bun runs it). Every relative
  import MUST carry a `.ts` extension (`./types.ts`) — enabled by
  `allowImportingTsExtensions`. Extensionless imports break the node test runner.
- Entry `src/index.ts`: V2 decodes ONLY `default` = plain `{ id, setup }`
  `satisfies Plugin.Plugin`. Types via `export type *`, NEVER `export *` (a
  leaked value broke 0.2.0).
- ZERO runtime deps. `@opencode/plugin` is a devDependency, `import type` ONLY
  in `src/` — no `Plugin.define`, no `Model.Info.default`. Tests may import
  values. Check: `npm ls --omit=dev` lists no `@opencode/*`.
- Root `index.ts` re-exports it: a local DIRECTORY plugin resolves `<dir>/server`
  then `<dir>/index` by path, never package.json `exports`. Npm installs use
  `exports`.
- `test/opencode-host.test.ts`: fake V2 ctx + replaying provider registry +
  stubbed proxy (`test/helpers/fake-opencode-host.ts`, modelled on 2.0.32).
  Change registry/event behaviour → update it. Helpers in `test/helpers/` so the
  `test/*.test.ts` glob skips them.
- Harness runs on NODE; OpenCode runs BUN. Touching exports, startup or the
  transform → run the probe (below). Never `--pure` — skips external plugins.

## The probe — USE IT for anything startup-related

`test/probe/README.md` has the commands. Throwaway `HOME` ALWAYS — never the
user's real service/config/logs.

- Config provider plugin activates AFTER user plugins (`post` in core
  `plugin/internal.ts`). In `setup` the LiteLLM provider does not exist. NEVER
  await discovery or the provider inside `setup` — activation is sequential,
  that deadlocks. Discovery starts on `provider.updated`.
- Transforms are SYNC + replayed on every rebuild: read captured data only, no
  I/O, no logging. Register the provider transform late (first discovery) so it
  folds after the config provider and sees user-curated models.
- First read of a fresh location can beat discovery (measured 2.0.32). Not a bug
  to "fix" with blocking.
- Ground truth = `opencode api model.list -H x-opencode-directory:$PWD`, not
  stdout. Without the header `opencode api` hits `$HOME`'s location.

## Cost mapping — load-bearing rules

- V2 `Model.Info.cost` = ARRAY of tiers `{ tier?, input, output, cache: { read,
  write } }`, USD per 1M. `cache.read`/`write` REQUIRED → unknown = 0 (as core's
  V1 migration does). `[]` = unpriced.
- ONE cost source: `/v1/model/info` on the configured proxy, keyed by
  `model_name` = the `/v1/models` id. Costs are per-TOKEN — they MUST go through
  `buildCost`/`perMillion` (×1e6). No price table, no `catalogURL`, no disk
  cache: all removed in 0.9.0 (`options.catalogURL`/`pricingURL` still sniffed,
  warned as dead, NEVER read).
- `/v1/model/info` ONLY, never `/v2/model/info`. LiteLLM v1.96.0 put
  `model_info_routes` (`/model/info`, `/v1/model/info`) into `llm_api_routes`;
  `/v2/model/info` stayed in `info_routes` = elevated key = 403 for exactly the
  keys this serves.
- Rows are per DEPLOYMENT: several can share a `model_name`. Dedupe = first row
  carrying BOTH `input_cost_per_token` and `output_cost_per_token` (what
  `buildCost` needs) wins, else first row. One deployment missing
  `base_model` must not price the whole group at nothing.
- A deployment with no `base_model` mapping resolves to NO cost fields, not to
  0 — so it injects unpriced and gets named in the log. Never invent a fallback.
- NEVER take cost from opencode's own provider/model lists: they list only the
  reader's configured providers, and report missing costs as 0 → real models
  priced $0.
- A tier only when both `input` and `output` are known. Keep a real `0` (free
  tier).
- Build tiers fresh per model — one info object serves several ids.
- Tiering: LiteLLM `*_above_200k_tokens` → second tier `{type:"context",
  size:200000}`. Do NOT map `*_above_272k_tokens` (overcharges 200k–272k).
- Pin prices against fixtures only — never against live upstream data.

## LiteLLM field semantics

- `max_input_tokens` = context window. `max_tokens` = legacy alias of max
  OUTPUT, not context. Never use `max_tokens` for `limit.context`.
- Azure / custom deployments need `model_info.base_model` set, else LiteLLM
  bills $0 and there is no cost to surface.

## Discovery rules

- `settings.baseURL` (V1 `options.*` normalizes to `settings.*`) is REQUIRED. No
  default URL, no port probing, never localhost. Missing → warn once, skip.
- Transform rewrites provider `settings.baseURL` to `<normalized>/v1` (the route
  POSTs `${baseURL}/chat/completions`) — ONLY while it still matches the
  discovered URL. Rewriting from a stale injection hides a config edit and sends
  traffic to the old proxy.
- Re-discover only when (baseURL, key, headers) change; our own `reload()`
  re-fires `provider.updated` → anything else loops. Failure → retry after 60s.
- `/v1/models` on current LiteLLM carries `mode`/`max_input_tokens`/
  `max_output_tokens` (never cost); older proxies return
  `id/object/created/owned_by` alone. `enrichModel` fills the gaps from the
  `/v1/model/info` block — lean entry WINS, info block only fills.
- `categorizeModel` signal order: `mode` → id heuristics → default chat.
- `/v1/model/info` is best-effort: full 15s budget (it is the pricing source,
  not enrichment), ANY failure falls back; never block/throw/drop. Refused →
  unpriced + the summary names v1.96.0. Pre-v1.96.0 it 403s for `key_type:
  "llm_api"` keys — not a misconfiguration.
- `mode` is classification input ONLY — never copy it into the emitted entry.
- Mode goes through `categorizeMode`, an ALLOW-list
  (`chat`/`completion`/`responses`); any other non-empty mode is non-chat.
  `null`/absent → next signal. LiteLLM really does emit `mode: null`.
- Id heuristics stay narrow — a false positive HIDES a working chat model.
  Never match bare `nova` / `e5` / `gte` / `audio`.
- Never overwrite a user-curated `providers.*.models` entry.
- Provider ids matched: `opencode-plugin-litellm-pricing` (package name),
  `opencode-litellm-pricing` (pre-0.3.0 name — user config, never drop it),
  `litellm`, `litellm-*`/`litellm_*`, `settings.litellm*` flags.
- `report()` = console only: V2 has no plugin logger, no `client.app.log`.
  Service mode DISCARDS it (not in opencode.log, measured 2.0.32); visible under
  foreground `opencode serve`.
- Fail soft: warn and continue; never throw out of discovery or a transform.
  Skip malformed entries and wildcard (`*`) ids.

## Release

- Tag-driven. Bump `version` in `package.json`, push `vX.Y.Z` (must match). CI
  publishes to npm via OIDC trusted publishing. Do not `npm publish` by hand.
- Tag on `master` AFTER merge — the workflow publishes whatever commit the tag
  points at, so tagging a branch ships unmerged code.
- Released → update `../opencode-presets/presets/plugin-litellm-pricing.conf`:
  `@pins`, `@description` (names the package), the body spec string, and bump
  that preset's own `@version`.

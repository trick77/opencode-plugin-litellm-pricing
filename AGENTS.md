# AGENTS.md

## Build / test

- Every relative import carries `.ts` (`./types.ts`). Extensionless imports
  break the node test runner.
- `src/index.ts`: types via `export type *`, NEVER `export *` (a leaked value
  broke 0.2.0).
- ZERO runtime deps. `@opencode/plugin` = devDependency, `import type` ONLY in
  `src/` — no `Plugin.define`, no `Model.Info.default`. Tests may import
  values. Check: `npm ls --omit=dev` lists no `@opencode/*`.
- `test/helpers/fake-opencode-host.ts` is modelled on 2.0.32. Change
  registry/event behaviour → update it.
- Harness runs on NODE; OpenCode runs BUN. Touching exports, startup or the
  transform → run the probe (`test/probe/README.md`). Never `--pure` — skips
  external plugins.
- Probe: first read of a fresh location beating discovery is not a bug to
  "fix" with blocking.

## Cost

- NEVER take cost from opencode's own provider/model lists: they list only the
  reader's configured providers and report missing costs as 0 → real models
  priced $0.
- Missing `base_model` → unpriced + named in the log. Never invent a fallback.
- `/v1/model/info` keeps the full 15s budget: it is the pricing source, not
  enrichment.
- Pin prices against fixtures only — never against live upstream data.

## Discovery

- NO periodic re-discovery of a healthy proxy (undecided).
- Fail soft: warn and continue; never throw out of discovery or a transform.

## Release

- Tag-driven: bump `version`, push `vX.Y.Z`. CI publishes via OIDC trusted
  publishing. Never `npm publish` by hand.
- Tag on `master` AFTER merge — the workflow publishes whatever commit the tag
  points at, so tagging a branch ships unmerged code.
- Released → update `../opencode-presets/presets/plugin-litellm-pricing.conf`:
  `@pins`, `@description` (names the package), the body spec string, and bump
  that preset's own `@version`.

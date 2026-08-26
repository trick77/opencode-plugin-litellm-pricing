# opencode-plugin-litellm-pricing

An [OpenCode](https://opencode.ai) plugin that lists the models on a
[LiteLLM](https://litellm.ai) proxy at startup and injects them into the model
picker with a per-model `cost` block, so OpenCode shows real pricing instead of
`$0`.

Everything comes from the proxy itself: `/v1/models` for the model list,
`/v1/model/info` for each model's price, kind, limits and capabilities. One URL
to configure, nothing fetched that you did not point it at, no local cache.

Requires **LiteLLM v1.96.0 or newer** — see [Requirements](#requirements).

## Install

Add the plugin and a LiteLLM provider to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-litellm-pricing@latest"],
  "provider": {
    "opencode-plugin-litellm-pricing": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM (proxy)",
      "options": {
        "baseURL": "https://litellm.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      }
    }
  }
}
```

`options.baseURL` is required; a provider without one is skipped with a warning.
The key is read from `options.apiKey`, else `$LITELLM_API_KEY` /
`$LITELLM_MASTER_KEY`. Extra auth headers (e.g. Cloudflare Access) go in
`options.customHeaders`.

Upgrading from 0.8.0 or earlier: delete `options.catalogURL` (or the older
`options.pricingURL`). Neither is read any more, and a config still carrying one
gets a warning saying so.

## How pricing works

Each chat-capable model is injected with a config entry like:

```json
{
  "name": "AI Gateway GPT 5.4",
  "limit": { "context": 1050000, "output": 128000 },
  "cost":  { "input": 2.5, "output": 15, "cache_read": 0.25 }
}
```

Cost, limits and capabilities come from `/v1/model/info`, keyed by `model_name`
— the same string `/v1/models` reports, so no name matching is involved. These
are LiteLLM's own resolved numbers, your config-level `model_info` overrides
included, so what OpenCode displays is what the gateway bills. They are stated
per token and converted to OpenCode's per-1M units.

Where a model group has several deployments, the one that resolved a price wins.
Models the proxy reports no cost for are injected **without** a `cost` block
rather than with a wrong one — usually a deployment whose `base_model` is unset
or misspelled, so LiteLLM cannot map it to a price-map entry. The startup log
names them. Wildcard (`*`) entries are skipped; they are access rules, not
models. Entries you have hand-curated under `provider.*.models` are never
overwritten.

Tiered pricing: opencode models a single `context_over_200k` tier, mapped from
LiteLLM's `*_above_200k_tokens` fields. `*_above_272k_tokens` is not mapped,
since forcing it into the 200k bucket would overcharge everything in between.

## Non-chat models

Embedding, image, audio, rerank and moderation models are kept out of the
picker, on LiteLLM's own `mode` field — carried both by `/v1/models` and by
every `/v1/model/info` entry. Anything whose mode isn't `chat` / `completion` /
`responses` is dropped.

If neither call reports a mode — an older proxy, or a key that cannot read
`/v1/model/info` — models are classified by name instead: `*-embedding-*`,
`*rerank*`, `dall-e-*` and so on. The patterns are deliberately narrow, since a
false positive hides a usable model; the trade-off is that an oddly named
non-chat model can slip through.

## The startup log

Messages go to the opencode server's stdout and to
`~/.local/share/opencode/log/opencode.log`:

```
grep litellm-pricing ~/.local/share/opencode/log/opencode.log
```

A healthy run:

```
[litellm-pricing] litellm: 34 models, 31 priced, 7 hidden
[litellm-pricing]   no pricing: my-finetune-v2, internal-router, … +1 more
```

`34 models` is what reached the picker, `31 priced` how many of those carry
cost, and `7 hidden` everything the proxy offered that was not injected —
non-chat models, wildcard access rules, and ids already in your config.
Unpriced models are named, not just counted.

`N models, 0 priced` is logged as a warning. Nothing priced at all almost always
means the pricing endpoint could not be read, and the line says so:

```
[litellm-pricing] litellm: 34 models, 0 priced, 7 hidden — /v1/model/info
  unreadable: needs LiteLLM v1.96.0+ and a key allowed to call it
```

A handful of unpriced models among priced ones is the other case: those are
per-deployment `base_model` gaps, not a version problem.

## Provider matching

A provider is enriched if its id is `opencode-plugin-litellm-pricing` (the
default), `opencode-litellm-pricing`, or `litellm`; if it starts with
`litellm-` / `litellm_`; or if its `options` sets `litellm: true` (or
`litellmCompatible` / `litellm-compatible`). With no matching provider the
plugin does nothing.

## Requirements

- OpenCode with plugin support
- Node 22+
- A reachable LiteLLM proxy, **v1.96.0 or newer**. That release moved
  `/model/info` and `/v1/model/info` into `llm_api_routes`, so an ordinary
  virtual key can read pricing; before it, only a key with admin-shaped
  privileges could. On an older proxy the models are still discovered and
  injected, just unpriced.
- A key allowed to call `/v1/model/info`. A key created with
  `key_type: "llm_api"` is enough. If yours has an explicit `allowed_routes`
  list, `/v1/model/info` has to be in it.

Check both at once:

```sh
curl -s -H "Authorization: Bearer $LITELLM_API_KEY" \
  https://litellm.example.com/v1/model/info | jq '.data[0].model_info'
```

## Releasing

Tag-driven. Bump `version` in `package.json`, then push a matching tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The `release` workflow checks the tag against `package.json`, publishes to npm
via OIDC trusted publishing, and cuts a GitHub Release. No npm token is
involved.

One-time prerequisites: an `npm-publish` GitHub environment, and a trusted
publisher on the npm package pointing at owner `trick77`, repo
`opencode-plugin-litellm-pricing`, workflow `release.yaml`, environment
`npm-publish`. All four must match exactly or the publish fails with a
misleading 404.

## License

MIT

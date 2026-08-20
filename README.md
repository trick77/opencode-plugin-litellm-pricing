# opencode-plugin-litellm-pricing

An [OpenCode](https://opencode.ai) plugin that lists the models on a
[LiteLLM](https://litellm.ai) proxy at startup and injects them into the model
picker with a per-model `cost` block, so OpenCode shows real pricing instead of
`$0`.

The proxy is asked only for its model list. Prices come from a table in
LiteLLM's `model_prices_and_context_window.json` format, matched by model name,
so `ai-gateway-gpt-5.4` is priced as `gpt-5.4`. You name the table — the plugin
fetches no URL you did not configure.

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
        "apiKey": "{env:LITELLM_API_KEY}",
        "catalogURL": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
      }
    }
  }
}
```

`options.baseURL` is required; a provider without one is skipped with a warning.
The key is read from `options.apiKey`, else `$LITELLM_API_KEY` /
`$LITELLM_MASTER_KEY`. Extra auth headers (e.g. Cloudflare Access) go in
`options.customHeaders`.

### The price table

`options.catalogURL` is required for pricing and has **no default**: the plugin
fetches the table you name and nothing else. A provider without one still gets
its models discovered and injected — they just carry no cost, and the startup
log says why.

The table earns its keep twice. Besides cost, each entry carries LiteLLM's
`mode` — `chat`, `embedding`, `image_generation`, and so on — which is what
keeps embedders, rerankers and image generators out of the model picker. The
proxy can answer that question too, via `/model_group/info`, but LiteLLM closes
that route to any key created as `key_type: "llm_api"`. On such a key the
catalog is the only classification the plugin has.

LiteLLM's published [`model_prices_and_context_window.json`][litellm-prices]
covers the public model line and is what the example above points at. If your
gateway serves an enriched copy — the upstream entries plus your own model
names, with their real context and pricing — point `catalogURL` at that
instead; those models then price by exact key rather than by substring against
the public line. Same format either way: one flat JSON object keyed by model
name, costs in USD per token. It is fetched once and cached — see
[The cache](#the-cache).

[litellm-prices]: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

## How pricing works

Each chat-capable model is injected with a config entry like:

```json
{
  "name": "AI Gateway GPT 5.4",
  "limit": { "context": 1050000, "output": 128000 },
  "cost":  { "input": 2.5, "output": 15, "cache_read": 0.25 }
}
```

Cost, limits and capabilities come from the price table, matched in two steps:

1. **Exact key.** A table entry named exactly as the proxy reports the model
   wins. This is what an enriched table is for.
2. **Bounded substring.** Otherwise `ai-gateway-gpt-5.4` → `gpt-5.4`.
   Longest match wins, so `…-mini` beats the base; `azure` is preferred over
   `openai`, and no other provider prefix is considered.

Table costs are per token and are converted to OpenCode's per-1M units. They are
public list prices, not your negotiated rates, unless your own table says
otherwise.

Models with no match are injected without a `cost` block rather than with a
wrong one. A match priced `0/0` across the board is treated the same way —
LiteLLM's table carries such entries for models that are plainly billable.
Wildcard (`*`) entries are skipped; they are access rules, not models. Entries
you have hand-curated under `provider.*.models` are never overwritten.

Tiered pricing: opencode models a single `context_over_200k` tier, mapped from
the table's `*_above_200k_tokens` fields. `*_above_272k_tokens` is not mapped,
since forcing it into the 200k bucket would overcharge everything in between.

**Why not LiteLLM's own numbers?** `/v1/model/info` carries them, but reading it
requires an admin key. Normal virtual keys get nothing back, so it is not usable
as a pricing source.

### The cache

The table is cached under `$XDG_CACHE_HOME/opencode-plugin-litellm-pricing/`
(`~/.cache/…` by default), keyed by URL:

| source | when |
| --- | --- |
| `cache` | the cached copy is less than 7 days old — no network at all |
| `stale cache (refreshing)` | it is older than 7 days: served anyway, with a refresh in the background |
| the price-table URL | no usable cache, so the table is fetched before the picker is built (3-second limit) |

The startup log names which one answered. No price table ships in the package,
so a start with no usable cache — a fresh install, a cleared cache, an upgrade
that changes the cache format — fetches one. If that fetch fails, models are
injected without a `cost` block and the log says so.

## Non-chat models

Embedding, image, audio, rerank and moderation models are kept out of the
picker. `/v1/models` returns only `{id, object, created, owned_by}`, so the
plugin also reads `/model_group/info`, which reports `mode` and the capability
flags under the same ids. Anything whose mode isn't `chat` / `completion` /
`responses` is dropped, and the limits and flags fill in what the price table
doesn't cover.

That call is best-effort with a 3-second budget. If your proxy doesn't allow it,
models are classified by name instead — `*-embedding-*`, `*rerank*`, `dall-e-*`
and so on. The patterns are deliberately narrow, since a false positive hides a
usable model; the trade-off is that an oddly named non-chat model can slip
through. The startup log says which path ran.

## The startup log

Messages go to the opencode server's stdout and to
`~/.local/share/opencode/log/opencode.log`:

```
grep litellm-pricing ~/.local/share/opencode/log/opencode.log
```

A healthy run:

```
[litellm-pricing] catalog: 3001 model(s) from cache — substring match via azure, openai
[litellm-pricing] litellm: 34 models, 31 priced, 7 hidden
[litellm-pricing]   no pricing: my-finetune-v2, internal-router, … +1 more
```

`34 models` is what reached the picker, `31 priced` how many of those carry
cost, and `7 hidden` everything the proxy offered that was not injected —
non-chat models, wildcard access rules, and ids already in your config.
Unpriced models are named, not just counted. `N models, 0 priced` is logged as a
warning — usually the catalog line above will say it was unavailable or empty,
or that no `catalogURL` was configured at all:

```
[litellm-pricing] provider "litellm" has no options.catalogURL — set it to a
  model catalog in LiteLLM `model_prices_and_context_window.json` format;
  every model will be injected without pricing.
```

## Provider matching

A provider is enriched if its id is `opencode-plugin-litellm-pricing` (the
default), `opencode-litellm-pricing`, or `litellm`; if it starts with
`litellm-` / `litellm_`; or if its `options` sets `litellm: true` (or
`litellmCompatible` / `litellm-compatible`). With no matching provider the
plugin does nothing.

## Requirements

- OpenCode with plugin support
- Node 22+
- A reachable LiteLLM proxy
- A price table in LiteLLM `model_prices_and_context_window.json` format, and
  outbound access to it. Needed on the first start; after that the cache
  answers and refreshes happen in the background

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

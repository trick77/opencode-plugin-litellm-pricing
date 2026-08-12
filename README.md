<h1>opencode-plugin-litellm-pricing</h1>

An [OpenCode](https://opencode.ai) plugin that discovers the models exposed
by a [LiteLLM](https://litellm.ai) proxy at startup and injects them into the
model picker — each with a **real per-model `cost` block**, so OpenCode shows
real pricing instead of `$0`.

The proxy is asked only for its **model list**. Pricing is never requested from
it: each model is matched by **name** against a price table in LiteLLM's
`model_prices_and_context_window.json` format, so `ai-gateway-gpt-5.4` is priced
as `gpt-5.4`. Same answer for every key, one code path. The table URL is
configurable — point it at your own enriched copy and your gateway's own model
names price exactly. See [How pricing works](#how-pricing-works).

> **Renamed in 0.3.0.** This package was `opencode-litellm-pricing`. npm has no
> rename, so that package is deprecated and frozen at 0.2.0 — which does not
> load (`Plugin export is not a function`). Point your `plugin` entry at
> `opencode-plugin-litellm-pricing`; there is no fix under the old name. Your
> `provider` key does not need to change: the old id is still matched.

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

`options.baseURL` is **required** — the plugin talks to that URL and nothing
else. A provider without one is skipped with a warning. The proxy key is read
from `options.apiKey`, else `$LITELLM_API_KEY` / `$LITELLM_MASTER_KEY`.

### Pointing at your own price table

`options.pricingURL` is optional. It defaults to LiteLLM's own published
[`model_prices_and_context_window.json`][litellm-prices], which covers the
public model line. If your gateway serves an **enriched copy** of that same file
— the upstream entries plus your own model names, with their real context and
pricing — point the plugin at it:

```json
"options": {
  "baseURL": "https://litellm.example.com/v1",
  "apiKey": "{env:LITELLM_API_KEY}",
  "pricingURL": "https://catalog.example.com/model_prices_and_context_window.json"
}
```

Any entry whose key is exactly the model name your proxy reports is used as-is —
no substring guessing. It must be the same format as upstream's file: one flat
JSON object keyed by model name, costs in USD **per token**.

[litellm-prices]: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

## How pricing works

At startup the plugin lists the proxy's models (`/v1/models`) and injects each
chat-capable one into the picker with a config entry like:

```json
{
  "name": "AI Gateway GPT 5.4",
  "limit": { "context": 1050000, "output": 128000 },
  "cost":  { "input": 2.5, "output": 15, "cache_read": 0.25 }
}
```

Cost, limits and capabilities come from the **price table**, matched to each
LiteLLM model by name in two steps:

1. **Exact key.** If the table has an entry named exactly as your proxy reports
   the model, that entry wins — this is what an enriched table is for.
2. **Bounded substring.** Otherwise `ai-gateway-gpt-5.4` → `gpt-5.4`:
   longest-match so `…-mini` beats the base, `azure` preferred over `openai`,
   and only those two providers, so a third-party aggregator's entry can never
   be what your model matches.

Costs in the table are stated per token and converted to OpenCode's per-1M
units. These are public list prices, not your negotiated rates — unless you
serve a table that says otherwise.

**Startup never waits on the network.** The plugin always answers from
something it already has, in this order:

| source | when |
| --- | --- |
| `cache` | a copy under `$XDG_CACHE_HOME/opencode-plugin-litellm-pricing/` (`~/.cache/…` by default) less than **7 days** old |
| `stale cache (refreshing)` | that copy is older than 7 days — it is still served immediately, and a refresh runs in the background for next time |
| `snapshot (refreshing)` | no cache at all (fresh install): LiteLLM's price table as shipped inside the package, likewise with a background refresh. With a custom `pricingURL`, its own entries arrive with the first refresh |

The startup log names which one answered. Only if the shipped snapshot were
itself unreadable would the plugin go to the network while you wait — and it
still injects the models in that case, just without a `cost` block, and says so.

This matters because the `config` hook OpenCode calls runs exactly once, before
anything is displayed: a fetch there is a stall you sit through. On a slow or
captive network that used to be up to ten seconds, every time the cache expired.

The cache holds only the fields the matcher reads — so it is ~700 KB rather
than the 1.7 MB LiteLLM publishes.

**Why not read the table from OpenCode?** It has one, and asking for it would
avoid the fetch. It cannot be done: OpenCode's server is unable to answer a
request while a plugin is blocked waiting on it, so awaiting that call during
plugin load deadlocks — measured at 60 s, versus 351 ms for the identical call
left unawaited, which lands after the `config` hook has already run. And that
hook runs exactly once, so there is no later pass to fill prices into. Earlier
releases did ask OpenCode, which is why they injected every model at `$0`.

Its other list also carries only the providers *you* have configured: with no
Azure credentials there is no `azure` entry at all, and the `openai` entry
OpenCode returns reports every cost as `0` — so a correctly-named model would
still have been priced at zero.

**Why not read LiteLLM's own numbers?** `/v1/model/info` carries them, but its
figures are only correct when the deployment has `model_info.base_model` set
properly. Get that wrong and LiteLLM itself bills `$0`, which the plugin would
faithfully pass on. Name-matching is the same answer for every key, and it can't
silently report zero.

**Tiered pricing:** opencode models a single `context_over_200k` tier, mapped
from the table's `*_above_200k_tokens` fields. A `*_above_272k_tokens` tier is
deliberately not mapped — forcing it into the 200k bucket would overcharge
everything between 200k and 272k.

If no catalog match is found, the `cost` block is **omitted** rather than shown
wrong. Existing entries you've hand-curated under `provider.*.models` are never
overwritten. Wildcard (`*`) entries are skipped — they are access rules, not
callable models.

## Non-chat models

Embedding, image, audio, rerank and moderation models are filtered out of the
picker.

`/v1/models` says which models your key can see, but not what kind each one is
— its response is just `{id, object, created, owned_by}`. LiteLLM keeps that in
a `mode` field, so the plugin also reads `/model_group/info`, which returns
`mode` plus the capability flags keyed by the same id. Anything whose mode
isn't `chat` / `completion` / `responses` is left out, and the limits and
capability flags it reports fill in what the price table doesn't cover.

That call is best-effort, with a 3-second budget. If your proxy doesn't allow
it, discovery carries on and models are classified by **name** instead —
`*-embedding-*`, `*rerank*`, `dall-e-*` and so on. The startup log tells you
which path ran. The name patterns are deliberately narrow, because a false
positive hides a model you can actually use: `amazon.nova-pro-v1` and
`gpt-4o-audio-preview` stay in the picker. The cost of that caution is that an
oddly-named non-chat model can slip through when the name is all we have.

## The startup log

Every message goes both to the opencode server's stdout and to opencode's own
log file, `~/.local/share/opencode/log/opencode.log` — so it can still be read
afterwards, or from a session that isn't attached to that stdout:

```
grep litellm-pricing ~/.local/share/opencode/log/opencode.log
```

A healthy run looks like this:

```
[litellm-pricing] catalog: 3001 model(s) from cache — substring match via azure, openai
[litellm-pricing] provider "litellm": 41 discovered, 34 added, pricing for 31/34
  (5 non-chat hidden, 2 wildcard ignored) from https://litellm.example.com
[litellm-pricing]   no pricing: my-finetune-v2, internal-router, … +1 more
```

Coverage is stated over the models actually **added**, not over everything
discovered: non-chat and wildcard entries never reach the picker, so they can't
bill anything. The unpriced models are named because a count alone doesn't say
which one will read as free. `pricing for 0/N` is logged as a **warning**, not
as info — that shape means something is systematically wrong, usually the
catalog line above reporting that it was unavailable or empty.

## Provider matching

The plugin enriches any provider whose id is `opencode-plugin-litellm-pricing`
(the default, matching the package name), the pre-0.3.0 name
`opencode-litellm-pricing`, or `litellm`, starts with `litellm-` /
`litellm_`, or whose `options` sets `litellm: true` (or `litellmCompatible` /
`litellm-compatible`). Extra auth headers (e.g. Cloudflare Access) can be
passed via `options.customHeaders`. With no matching provider in your config,
the plugin does nothing.

## Requirements

- OpenCode with plugin support
- Node 22+
- A reachable LiteLLM proxy
- Outbound access to the price-table URL to refresh prices. Not required to
  run: a price table ships with the package, and refreshes happen in the
  background

## Releasing

Tag-driven. Refresh the shipped price table (`npm run update-snapshot`), bump
`version` in `package.json`, then push a matching tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The `release` workflow verifies the tag matches `package.json`, then publishes
to npm via OIDC trusted publishing and cuts a GitHub Release.

Prerequisites, one-time: an `npm-publish` GitHub environment, and a trusted
publisher on the npm package pointing at owner `trick77`, repo
`opencode-plugin-litellm-pricing`, workflow `release.yaml`, environment
`npm-publish`. All four must match exactly or the publish fails with a
misleading 404.

No npm token is involved — authentication is OIDC, which is also what
`--provenance` signs with. Note that trusted publishing cannot create a package
that does not exist yet, which is why 0.1.0 was published by hand and carries no
provenance attestation — and why 0.3.0, the first release under the renamed
package, was too. Every other tagged release is published by CI with provenance.

## License

MIT

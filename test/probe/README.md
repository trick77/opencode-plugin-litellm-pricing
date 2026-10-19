# The probe — running the plugin inside a real opencode 2

`npm test` drives the plugin against a fake registry. That cannot see what
only the real host shows: plugin activation order, whether `provider.updated`
really arrives after the config provider registers, whether the transform's
output survives opencode's own model resolution, and which key reaches the
proxy. Those need a real opencode process.

The config is V1-shaped on purpose (`provider` + `npm` + `options`, baseURL
without `/v1`, a hand-curated model): it is what the opencode-presets
`provider-litellm` preset writes, and it exercises opencode's normalization,
the `/v1` rewrite and the never-overwrite rule in one go.

## Run it

Isolated: a throwaway `HOME`, so the user's real service, config and logs are
never touched. Two terminals, from the repo root:

```sh
node test/probe/fake-proxy.mjs        # stands in for LiteLLM on :7801, logs every request + key
```

```sh
export HOME=$(mktemp -d) OPENCODE_CONFIG=$PWD/test/probe/opencode.json PROBE_LITELLM_KEY=sk-probe
cd test/probe && opencode service set port 49401 && opencode service restart
opencode models | grep litellm        # first call on a fresh location may race discovery — run twice
D="x-opencode-directory:$PWD"         # `opencode api` targets $HOME's location otherwise
opencode api model.list -H "$D" | jq '.data[] | select(.providerID=="litellm") | {id, name, cost, limit}'
opencode api provider.get --param providerID=litellm -H "$D" | jq .data.settings.baseURL   # ends in /v1
opencode service stop
```

Expected: `ai-gateway-gpt-5.4` priced with two tiers (base + 200k context),
`ai-gateway-gpt-5.4-mini` keeping its hand-curated name and no cost, the
embedding and video models absent, and the fake proxy logging
`auth=Bearer sk-probe` — proof that `{env:…}` was substituted before the
plugin read it.

The plugin's summary line is console-only and the background service discards
it. To see it, run `opencode serve --port 49402` in the foreground with the same
environment instead of the service, and point the CLI at it with
`--server http://127.0.0.1:49402` (set `OPENCODE_SERVER_PASSWORD` for both).

## What this exists to catch

- **The config provider activates after user plugins.** During `setup` the
  LiteLLM provider does not exist yet; discovery starts from the
  `provider.updated` that follows. Awaiting it inside `setup` would deadlock
  activation.
- **The first read of a fresh location can beat discovery.** Measured on
  2.0.32: the first `opencode models` lists only configured models, the second
  lists the discovered ones too. opencode's own config provider shows the same
  race on `provider.get`.
- **Prices reaching the log is not the same as prices reaching the picker.**
  Assert against `opencode api model.list`, not against stdout.

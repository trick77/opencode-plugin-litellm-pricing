# The probe — running the plugin inside a real opencode

`npm test` drives the `config` hook directly. That cannot see the things that
actually broke this plugin: how many times opencode invokes the hook, whether a
client call can be answered while a plugin is blocked on it, and whether the
prices survive into what opencode serves. Those need a real opencode process.

## Run it

Two terminals, from the repo root:

```sh
node test/probe/fake-proxy.mjs                       # stands in for LiteLLM, port 7801
cd test/probe && opencode models                     # loads the plugin, prints its log
```

`opencode models` is enough for startup behaviour. To inspect what opencode
actually *serves* — the ground truth, since the log only proves the code ran:

```sh
cd test/probe && opencode serve --port 7812 --hostname 127.0.0.1 &
curl -s http://127.0.0.1:7812/config/providers \
  | jq '.providers[] | select(.id=="litellm") | .models'
```

To exercise a cold start, clear the price-table cache first:

```sh
rm -rf ~/.cache/opencode-plugin-litellm-pricing
```

## What this exists to catch

- **The hook runs exactly once.** Measured under both `opencode serve` and the
  CLI. Anything that defers work to "a later pass" is dead code.
- **An awaited opencode client call during plugin load deadlocks.** The server
  cannot answer a request while a plugin blocks on it: awaiting
  `config.providers` / `provider.list` timed out at 60 s, while the identical
  unawaited call returned in 351 ms — after the hook had already run. This is
  why the price table is fetched over plain HTTPS instead.
- **Prices reaching the log is not the same as prices reaching the picker.**
  Assert against `/config/providers`, not against stdout.

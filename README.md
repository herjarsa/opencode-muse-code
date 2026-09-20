# opencode-muse-code

Use your Muse Code (Meta) subscription in OpenCode.

The plugin reads the login the [`muse`](https://api.meta.ai/muse-launcher.sh) CLI
already stored on your machine, registers a `muse-code` provider that talks to
`https://api.meta.ai/v1`, and lists the Muse Spark models with their real limits
and reasoning-effort variants. Model requests are billed against your Muse Code
subscription by Meta.

## Requirements

- OpenCode V2
- The `muse` CLI installed and signed in (`muse`). The plugin reads the login it
  saved in the macOS keychain (or `~/.config/muse/auth.json` on other systems).

## Install

Add the package to the `plugins` list in `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-muse-code"]
}
```

Or copy this folder to `~/.config/opencode/plugins/muse-code/`; plugin
directories there are loaded automatically.

Or clone the repository and point OpenCode at the checkout:

```sh
git clone https://github.com/swalker326/opencode-muse-code.git
```

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-muse-code"]
}
```

Restart the OpenCode service (`opencode service restart`) or reopen OpenCode.

## Use

Select a model like `muse-code/muse-spark-1.3` with `/models`, or run:

```sh
opencode run --model muse-code/muse-spark-1.3 "hello"
```

Variant suffixes pick a reasoning effort, for example
`muse-code/muse-spark-1.3#max` (`minimal`, `low`, `medium`, `high`, `xhigh`,
`max`). The default comes from the model metadata.

## How it works

1. **Find the login.** Credentials are resolved in order: the plugin `key`
   option, then `META_API_KEY` / `MUSE_API_KEY`, then the macOS keychain item
   `ai.meta.dev.credentials` (account `meta`), then `~/.config/muse/auth.json`.
2. **Get an API key.** It uses the stored API key, or mints one from the OAuth
   token by calling `POST https://api.meta.ai/muse-code/key`. Minting is
   idempotent: the same account always gets the same key back.
3. **Discover models.** It reads Meta's catalog from
   `GET https://api.meta.ai/muse-code/models`, keeping tool-capable text models
   and their real limits, input types, and reasoning-effort variants.
4. **Register the provider.** OpenCode receives a provider definition with ID
   `muse-code`, display name "Muse Code Sub Plugin", the OpenAI-compatible
   runtime, endpoint `https://api.meta.ai/v1`, the minted key, and one model
   entry per Muse Spark model. Variants map to the `reasoning_effort` request
   field.
5. **Stay fresh.** Every 30 minutes it re-reads the login, re-fetches the
   catalog, and reloads the provider. On unload it stops the timer and removes
   its registration.

Requests go from OpenCode to `https://api.meta.ai/v1` with the minted key; Meta
meters them against your Muse Code subscription.

## Options

Pass a key directly instead of reading the login:

```jsonc
{
  "plugins": [{ "package": "opencode-muse-code", "options": { "key": "..." } }]
}
```

The `META_API_KEY` and `MUSE_API_KEY` environment variables are also honored.

## Troubleshooting

- **Unauthorized**: run `muse` and sign in again, then restart the service. If
  you also stored an API key for this provider in OpenCode, update or remove
  that stored account so it cannot shadow the keychain login.
- **No models listed**: the first refresh failed and the fallback catalog was
  used; check the network and restart the service.
- **Linux**: Muse CLI credential storage differs by platform. If the keychain
  is not readable, set `META_API_KEY` or the plugin `key` option.

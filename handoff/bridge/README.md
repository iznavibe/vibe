# Bridge

Exposes this desktop's `vibe-server` to the phone over an HTTPS tunnel.

`vibe-server serve` has **no authentication of any kind** — the only auth
strings in the binary belong to its bundled Swagger UI. Tunnelled as-is, anyone
who finds the URL gets unmetered use of the GPU. This sits in front, holds a
bearer token, and answers the CORS preflights the phone app needs because it is
served from a different origin.

## Running it

```sh
# 1. the engine, with whichever model you want it to use
vibe-server serve --port 8123 "%LOCALAPPDATA%\github.com.thewh1teagle.vibe\ggml-large-v3.bin"

# 2. the gate
node handoff/bridge/bridge.mjs --target http://127.0.0.1:8123 --port 8130

# 3. the tunnel
cloudflared tunnel --url http://127.0.0.1:8130
```

The bridge prints a token on first run and keeps it in `token.txt`. Put the
`https://….trycloudflare.com` address and that token into the phone app under
Settings → Your desktop, and press **Test connection**.

## What it allows through

Only `/health`, `/v1/models` and `/v1/audio/transcriptions`. Everything else is
404 whether the token is right or not, so the Swagger UI and the model-loading
endpoints are not reachable from outside.

The token is compared in constant time: it is the only thing between the open
internet and this machine's GPU.

## A quick tunnel's address changes

`cloudflared tunnel --url` gives a fresh `trycloudflare.com` hostname every time
it starts, so the phone needs the new address after each restart. A named tunnel
gives a permanent one but needs a domain on Cloudflare. The token is what makes
either safe; the address is not a secret.

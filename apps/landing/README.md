# Patio Station — landing

A single-page landing for Patio: *Ethereum is the radio.*

- `index.html` — the built page. Fully self-contained (fonts and background are inlined), so it can be served from any static host or opened directly.
- `src/landing.src.html` — the source you edit. Fonts and the background image are `{{PLACEHOLDERS}}`.
- `assets/` — Geist Pixel, terminalGrotesque and the graffiti wall used by the app.
- `build.py` — inlines `assets/` into the source and writes `index.html`.

```bash
python3 apps/landing/build.py
```

## Live data

The network strip, the mempool view and the pending-transaction ribbon read Hoodi from the public RPC `https://ethereum-hoodi-rpc.publicnode.com` (no key). Where that request is blocked (for example inside a sandboxed preview), the page falls back to approximate values marked with `~` and hides the ribbon.

## Editing the news cards

The censorship cases live in the `STORIES` array in `src/landing.src.html`. Set `img` to a URL or `data:` URI to use your own picture; it gets the same pixel + dither treatment as the built-in flags.

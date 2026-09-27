# Patio — Tokyo26

Patio is an experiment in open information and a project that helped shape my life.

It is part of why I am where I am today, both professionally and personally. Patio helped me find my way through the Ethereum ecosystem, taught me more than I could have imagined, and introduced me to people who became great friends.

Being in Tokyo is part of that journey. Bringing Patio back during this hackathon is my way of giving something back to a project and a community that have given me so much.

## What Patio does

Patio explores live audio and tiny video transported through Ethereum's public mempool. Media is divided into signed transaction packets on the Hoodi testnet and reconstructed by listeners in the browser.

The current application includes:

- A project landing page at `/`.
- A live broadcast directory and listener at `/live`.
- Audio and tiny video broadcast controls at `/live/cast`.
- Wallet-side signing, packet encoding, playback, and transaction recovery tools.

## Project structure

```text
apps/
  landing/     Editable source and assets for the landing page
  web/         Next.js application and Hoodi API routes
packages/
  config/      Network profiles and limits
  ethereum/    Transaction planning and policy
  protocol/    Patio packet codecs and reconstruction
  wallet-core/ Wallet operation state and persistence
```

## Run locally

Patio uses Node.js 24 and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm dev:web
```

Create a production build with:

```sh
pnpm build
```

## Hoodi configuration

Broadcasting is enabled only when the deployment has a reviewed Hoodi provider configuration:

```text
PATIO_HOODI_BETA_ENABLED=true
PATIO_HOODI_QUICKNODE_RPC_URL=https://…ethereum-hoodi.quiknode.pro/…
```

`PATIO_HOODI_QUICKNODE_RPC_URL` is server-only and must never be committed. Public broadcast listings can additionally use `NEXT_PUBLIC_HOODI_PATIO_REGISTRY_ADDRESS`.

## Why it matters

Everyone should be able to access information freely. For people who cannot, that freedom can make a real difference. Patio is my small contribution toward that possibility and a fairer world.

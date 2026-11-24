# Patio

Live audio and tiny video broadcast through Ethereum's mempool, sent as pending transactions on testnets.

**Listen at [patio.fm](https://patio.fm).** Listening needs no wallet.

## Tune in from a terminal

```bash
cd transport
npm install
npm run listen
```

This finds the newest public broadcast on Polygon Amoy and saves its voice as a WebM file. Pass a link someone shared to hear an unlisted one, or pipe it into a player to hear it live:

```bash
npm run listen -- --out - | ffplay -nodisp -
```

It reads only the chain, public nodes and public Nostr relays. No wallet, no Patio server.

## What's here

- [`transport/`](./transport): how it works on Polygon Amoy, Gnosis Chiado and Hoodi, with the packet format, the listener above, and the registry contract. MIT licensed.
- [`ethdenver-2024/`](./ethdenver-2024): the original project from ETHDenver 2024, kept as it was. It is not covered by the MIT license.

Patio runs on testnets only. Do not use this technique on a mainnet.

## Contributing

Questions, bugs and ideas are welcome in [issues](https://github.com/victxx/patio/issues). Pull requests to `transport/` should keep `npm test` and `npm run typecheck` passing.

## Credits

The original concept is by [ariutokintumi](https://x.com/ariutokintumi), from ETHDenver 2024. Built with [Antoine De Vuyst](https://x.com/AntoineDeVuyst). Patio.fm is by [victorxva](https://x.com/victorxva).

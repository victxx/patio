# Patio transport

Patio is a live radio that travels through Ethereum's pending transaction pool. Audio, and optionally a tiny picture track, is sent as calldata in transactions that wait in the mempool. Listeners read those pending transactions and play them. The media is not stored in blocks.

This document explains how the transport works on three testnets, **Polygon Amoy**, **Gnosis Chiado** and **Hoodi**. It covers the idea and the wire format. It is not the application.

## Tune in from a terminal

```bash
npm install
npm run listen                                  # newest public broadcast on Amoy
npm run listen -- "https://patio.fm/listen?…"   # a link someone shared
npm run listen -- --out - | ffplay -nodisp -    # hear it as it arrives
```

It writes the broadcast's voice to a WebM file you can open in any player, and stops when the broadcaster closes. No wallet and no Patio server are involved: it reads the chain, public nodes and public Nostr relays. Options are at the top of [`examples/listen.ts`](./examples/listen.ts).

## In this folder

- `src/packet.ts`: encode and decode packets.
- `src/media.ts`: take the voice out of a packet and join packets into one file.
- `src/hints.ts`: the Nostr hints described below.
- `src/plan.ts`: the nonce and fee rules described below.
- `src/networks.ts`: chain IDs, public nodes and registry addresses.
- `contracts/PatioOpenRegistryV2.sol`: the public directory of broadcasts.
- `examples/listen.ts`: the listener above.

```bash
npm test
```

```ts
import { decodePacket, encodePacket, PacketType } from "./src";

const input = encodePacket({
  type: PacketType.AUDIO,
  codec: 1,
  flags: 0,
  streamId: "0x00112233445566778899aabbccddeeff",
  windowIndex: 0,
  sequence: 0,
  capturedAtMs: BigInt(Date.now()),
  payload: new Uint8Array([1, 2, 3]),
});

decodePacket(input).sequence; // 0
```

This is a minimal extract, not the full Patio app. Everything in this folder is under the [MIT license](./LICENSE). The original project in `ethdenver-2024/` is not covered by it.

Patio runs on testnets only. Do not use this technique on a mainnet.

## The idea

1. A broadcaster records a few seconds of audio.
2. The audio goes into the `data` field of a type-2 (EIP-1559) transaction that sends 0 value to its own sender.
3. That transaction uses a nonce that cannot execute yet, so it stays pending.
4. The next packet replaces the previous one at the same nonce, with a higher fee.
5. Listeners poll the pool, take the packets from that sender and play them in order.

## Why packets stay pending

Each broadcast uses a new temporary key whose nonce starts at 0.

- **Nonce 0 is left unsent on purpose.** That is the gap.
- **Media uses nonces 1, 2, 3 and up.** Those transactions cannot execute while nonce 0 is missing, so no block can include them.
- Each media nonce is replaced several times, then the next nonce starts:

```text
media nonce = gap + 1 + floor(sequence / replacementsPerWindow)
```

### Replacement fees

Nodes only accept a replacement if it pays more. Each step raises both the max fee and the tip by 12.5%. The first max fee in a window is `2 × base fee + tip`.

Gas is fixed for the whole session:

```text
gas = 21000 + 40 × (maxPayload + 76)
```

For a 20 KiB audio packet that is 843,240 gas.

Media transactions pay nothing unless they execute. The balance only has to be large enough for nodes to accept them.

## Closing and returning funds

To end a broadcast:

1. Sending stops and the queue drains.
2. The broadcaster waits 6 seconds so listeners hear the last packets.
3. The temporary key signs one transfer at nonce 0, back to the wallet that funded it.

That transfer fills the gap and takes the whole balance, minus its own gas. Queued media transactions can then no longer pay for themselves, because EIP-1559 requires `gas × maxFee + value` to be available up front. They stop being able to execute even though they are still signed.

**Old signed packets never expire.** Never send funds to a finished broadcast's temporary address.

## Packet format

Big-endian. 76 bytes of overhead, payloads up to 24 KiB. Every packet is checked against its keccak256 before use.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic `PTIO` |
| 4 | 1 | Version (1) |
| 5 | 1 | Type: 1 START, 2 AUDIO, 3 END, 4 VIDEO |
| 6 | 1 | Codec: 1 Opus in WebM, 5 Opus in WebM with pictures |
| 7 | 1 | Flags |
| 8 | 16 | Stream ID |
| 24 | 4 | Window index |
| 28 | 4 | Sequence |
| 32 | 8 | Captured at (ms) |
| 40 | 4 | Payload length |
| 44 | n | Payload |
| 44 + n | 32 | keccak256 of header and payload |

**START** is media too. It marks a packet a listener can begin with, because it carries the WebM initialization segment. AUDIO packets continue from the one before.

## Media

- **Audio:** Opus in WebM, 16 kbps, mono, 6 seconds per packet. The payload is `PAA1`, a 2-byte length of the initialization segment (0 if there is none), then the WebM bytes.
- **Picture (codec 5):** voice plus still frames in the bytes the voice leaves free. The payload is `VI`, a version, the image codec (VP8, VP9 or JPEG), the voice length, width, height and frame count, then the voice exactly as above, then the frames. Up to 192 px on the long side and 8 frames per second. It is not continuous video, and a packet without frames is still a whole voice packet.

## Finding and hearing a broadcast

**Finding it.** Public broadcasts are listed in a small registry contract. It emits an event with the stream ID, operator, session address, starting nonce, expiry and media mode. Media never enters the contract. A listener reads recent events and drops any session whose nonce has moved past the start or whose expiry has passed. Unlisted broadcasts are not in the registry: their share link carries the same details.

In the registry (v2), the session wallet signs each announcement, so an operator can only list a session that agreed to it, and a stream ID belongs to its operator, so nobody can take another operator's stream.

**Hearing it.** A listener polls the pending pool about every 750 ms for the session address (`txpool_contentFrom`), parses the `input` of each transaction, checks the magic, checksum and stream ID, and reorders packets into a buffer. In a browser, playback uses MediaSource.

**Hints.** Nodes do not pass gapped transactions on to each other, so a packet can sit on one public node and not on another, and many public endpoints are several machines behind one address. A pool read can come back empty while the packet exists. So the broadcaster also publishes the hash of each packet on public Nostr relays: kind 20049, tagged `patio-media-hint`, with the `d` tag `<session>:<stream>` and the content `{"v":1,"c":chain,"q":sequence,"h":hash}`. A listener looks each hash up on several public nodes. A hint is never trusted as media: the transaction must come from the session and decode as a packet of that stream. A share link names the Nostr key that signs its hints (`nh`).

The end of a broadcast is the receipt of the return transfer at nonce 0.

## Networks

The pipeline is the same on all three. The differences are:

| | Polygon Amoy | Gnosis Chiado | Hoodi |
|---|---|---|---|
| Chain ID | 80002 | 10200 | 560048 |
| Audio packet | 6 s, 20 KiB | 6 s, 20 KiB | 6 s, 20 KiB |
| Picture packet | 6 s, 24 KiB | 6 s, 24 KiB | 6 s, 24 KiB |
| Minimum tip | 25 gwei, or the node's suggestion if higher | 1 gwei | 1 gwei |
| Block time expected | 1–2 s | 5 s | 12 s |
| Longest capture per session | 600 s | 600 s | 600 s |
| Most nonces per session | 40 | 40 | 40 |
| Maximum funds at risk per session | 10 POL | 0.25 xDAI | 0.25 ETH |

### Registry addresses

`PatioOpenRegistryV2`, deployed 10 November 2026:

| Network | Address |
|---|---|
| Polygon Amoy | [`0x9e69330b089c3a113977320d1adacca2d9bdddd2`](https://amoy.polygonscan.com/address/0x9e69330b089c3a113977320d1adacca2d9bdddd2) |
| Gnosis Chiado | [`0xb09b6aa7b9521d45161f8c46c6cfe01b66699cad`](https://gnosis-chiado.blockscout.com/address/0xb09b6aa7b9521d45161f8c46c6cfe01b66699cad) |
| Hoodi | [`0xf3d1609b8b7174e0998474870e7daaa701a5bdee`](https://hoodi.etherscan.io/address/0xf3d1609b8b7174e0998474870e7daaa701a5bdee) |

The earlier open registry (v1) is retired. It emitted the same events, so a reader of v2 events can read v1 history too.

## Credits

The original concept is by [ariutokintumi](https://x.com/ariutokintumi), from ETHDenver 2024. Built with [Antoine De Vuyst](https://x.com/AntoineDeVuyst). Patio.fm is by [victorxva](https://x.com/victorxva).

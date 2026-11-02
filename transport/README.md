# Patio transport

Patio is a live radio that travels through Ethereum's pending transaction pool. Audio, and optionally a tiny picture track, is sent as calldata in transactions that wait in the mempool. Listeners read those pending transactions and play them. The media is not stored in blocks.

This document explains how the transport works on two testnets, **Hoodi** and **Polygon Amoy**. It covers the idea and the wire format. It is not the application.

## In this folder

- `src/packet.ts`: encode and decode packets.
- `src/plan.ts`: the nonce and fee rules described below.
- `contracts/PatioOpenRegistry.sol`: the public directory of broadcasts.

```bash
npm install
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

Media transactions pay nothing unless they execute. The balance only has to be large enough for nodes to accept them.

## Closing and returning funds

To end a broadcast:

1. Sending stops and the queue drains.
2. The broadcaster waits 6 seconds so listeners hear the last packets.
3. The temporary key signs one transfer at nonce 0, back to the wallet that funded it.

That transfer fills the gap and takes the whole balance, minus its own gas. Queued media transactions can then no longer pay for themselves, because EIP-1559 requires `gas × maxFee + value` to be available up front. They stop being able to execute even though they are still signed.

**Old signed packets never expire.** Never send funds to a finished broadcast's temporary address.

## Packet format

Big-endian. 76 bytes of overhead, payloads up to 24 KiB.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic `PTIO` |
| 4 | 1 | Version (1) |
| 5 | 1 | Type: 1 START, 2 AUDIO, 3 END, 4 VIDEO |
| 6 | 1 | Codec |
| 7 | 1 | Flags |
| 8 | 16 | Stream ID |
| 24 | 4 | Window index |
| 28 | 4 | Sequence |
| 32 | 8 | Captured at (ms) |
| 40 | 4 | Payload length |
| 44 | n | Payload |
| 44 + n | 32 | keccak256 of header and payload |

## Media

- **Audio:** Opus in WebM, 16 kbps, mono. Every packet can start playback by itself because it carries the WebM init segment.
- **Picture:** voice plus still frames in the bytes the voice leaves free. Up to 192 px on the long side and 8 frames per second, encoded as VP9, VP8 or JPEG. It is not continuous video.

## Finding and hearing a broadcast

**Finding it.** A small registry contract emits an event with the stream ID, operator, session address, starting nonce, expiry and media mode. Media never enters the contract. A listener reads recent events and drops any session whose nonce has moved past the start or whose expiry has passed.

**Hearing it.** A listener polls the pending pool about every 750 ms for the session address, parses the `input` of each transaction, checks the magic, checksum and stream ID, and reorders packets into a buffer. Playback uses MediaSource.

Replaced packets disappear from the pool quickly, so a poll can miss some. Remembering recent transaction hashes and fetching them directly fills most of those holes.

The end of a broadcast is the receipt of the return transfer at nonce 0.

## Hoodi and Amoy

The pipeline is the same. The differences are:

| | Hoodi | Polygon Amoy |
|---|---|---|
| Chain ID | 560048 | 80002 |
| Audio packet | 6 s, 16 KiB | 6 s, 16 KiB |
| Picture packet | 6 s, 24 KiB | 6 s, 24 KiB |
| Minimum tip | 1 gwei | 25 gwei, or the node's suggestion if higher |
| Block time expected | 12 s | 1 s |
| Longest capture per session | 600 s | 600 s |
| Most nonces per session | 40 | 40 |
| Maximum funds at risk per session | 0.25 ETH | 10 POL |

## Credits

The original concept is by [ariutokintumi](https://x.com/ariutokintumi), from ETHDenver 2024. Built with [Antoine De Vuyst](https://x.com/AntoineDeVuyst). Patio.fm is by [victorxva](https://x.com/victorxva).

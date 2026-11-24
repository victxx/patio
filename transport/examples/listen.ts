/**
 * Tune in to a live Patio broadcast from a terminal.
 *
 *   npm run listen                        newest public broadcast on Amoy
 *   npm run listen -- chiado              another network
 *   npm run listen -- "https://patio.fm/listen?station=…"   a shared link
 *   npm run listen -- --out - | ffplay -nodisp -   hear it as it arrives
 *
 * Options:
 *   --session 0x…   a session address instead of the newest announcement
 *   --rpc https://… your own node
 *   --out file      where to write the audio (default patio-<stream>.webm)
 *
 * It finds a broadcast, then collects its packets two ways at once:
 *   - reading the session's pending transactions about every 750 ms;
 *   - looking up by hash, on several public nodes, each packet the
 *     broadcaster hints on Nostr.
 * It keeps the Patio packets in order and writes their voice as one WebM
 * file. It stops when the broadcaster returns the funds, which fills the
 * nonce gap. No Patio server is involved.
 */
import { createWriteStream } from "node:fs";
import { SimplePool } from "nostr-tools/pool";
import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";

import {
  BROADCAST_ANNOUNCED,
  Codec,
  BROADCAST_ENDED,
  decodePacket,
  HINT_KIND,
  HINT_RELAYS,
  hintTopic,
  NETWORKS,
  PacketType,
  parseHint,
  voiceFromPayload,
  WebmJoiner,
  type NetworkId,
  type Packet,
} from "../src";

const POLL_MS = 750;
/** How long to wait for a missing packet before moving past it. */
const GAP_WAIT_MS = 6_000;
/** A hinted transaction may reach the node a moment after its hint. */
const LOOKUP_RETRIES_MS = [0, 1_500, 3_000, 6_000, 6_000];

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
// A shared link names the session, stream, starting nonce, chain and the
// Nostr key that signs its hints. Unlisted broadcasts are only found this way.
const link = args.find((a) => a.includes("station="));
const linked = link ? new URL(link).searchParams : null;
const networkId = ((linked &&
  Object.keys(NETWORKS).find(
    (id) => String(NETWORKS[id as NetworkId].chainId) === linked.get("chain"),
  )) ??
  args.find((a) => a in NETWORKS) ??
  "amoy") as NetworkId;
const network = NETWORKS[networkId];
const client = createPublicClient({
  transport: http(option("rpc") ?? network.rpc),
});
const lookupClients = (
  option("rpc") ? [option("rpc")!] : network.lookupNodes
).map((url) => createPublicClient({ transport: http(url) }));
const log = (line: string) => process.stderr.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Broadcast {
  session: Address;
  streamId?: Hex;
  nonceStart: number;
  /** Nostr public key that signs this broadcast's hints, if known. */
  hintAuthor?: string;
}

async function newestBroadcast(): Promise<Broadcast | null> {
  const latest = await client.getBlockNumber();
  const range = {
    address: network.registry,
    fromBlock: latest - network.lookbackBlocks,
    toBlock: latest,
  };
  const [announced, ended] = await Promise.all([
    client.getLogs({ ...range, event: BROADCAST_ANNOUNCED }),
    client.getLogs({ ...range, event: BROADCAST_ENDED }),
  ]);
  const over = new Set(
    ended.map((e) => `${e.args.operator}:${e.args.streamId}`.toLowerCase()),
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const { args: a } of announced.reverse()) {
    if (over.has(`${a.operator}:${a.streamId}`.toLowerCase())) continue;
    if (a.expiresAt! <= now) continue;
    const nonce = await client.getTransactionCount({ address: a.session! });
    // Past the gap means the funds went back: the broadcast is over.
    if (nonce > Number(a.nonceStart)) continue;
    return {
      session: a.session!,
      streamId: a.streamId!,
      nonceStart: Number(a.nonceStart),
    };
  }
  return null;
}

async function chooseBroadcast(): Promise<Broadcast | null> {
  const station = linked?.get("station");
  if (station)
    return {
      session: getAddress(station),
      streamId: (linked!.get("stream") ?? undefined) as Hex | undefined,
      nonceStart: Number(linked!.get("nonce") ?? 0),
      hintAuthor: linked!.get("nh") ?? undefined,
    };
  const given = option("session");
  if (given) {
    const session = getAddress(given);
    return {
      session,
      nonceStart: await client.getTransactionCount({ address: session }),
    };
  }
  return newestBroadcast();
}

type Pool = Record<string, Record<string, { input: Hex }>>;

async function readPool(session: Address): Promise<Hex[]> {
  const pool = (await client.request({
    method: "txpool_contentFrom" as never,
    params: [session] as never,
  })) as Pool | null;
  return Object.values(pool ?? {}).flatMap((byNonce) =>
    Object.values(byNonce).map((tx) => tx.input),
  );
}

async function main() {
  const broadcast = await chooseBroadcast();
  if (!broadcast) {
    log(`Nothing on air on ${network.name} right now. Go live at patio.fm.`);
    return;
  }
  log(`Tuned in to ${broadcast.session} on ${network.name}`);

  let out: NodeJS.WritableStream | null = null;
  const joiner = new WebmJoiner();
  const waiting = new Map<number, Packet>();
  let next: number | null = null;
  let missingSince: number | null = null;
  let afterGap = false;
  let ended = false;
  const found = { pool: 0, hint: 0 };

  /** Any transaction input from either path: keep it if it belongs here. */
  const take = (input: Hex, path: keyof typeof found) => {
    try {
      const packet = decodePacket(input);
      if (broadcast.streamId && packet.streamId !== broadcast.streamId) return;
      broadcast.streamId ??= packet.streamId;
      if (next !== null && packet.sequence < next) return;
      if (waiting.has(packet.sequence)) return;
      waiting.set(packet.sequence, packet);
      found[path]++;
    } catch {
      // Not a Patio packet, or damaged: skip it.
    }
  };

  const play = (packet: Packet) => {
    if (packet.type === PacketType.END) ended = true;
    // START is media too: a packet a listener can begin with, because it
    // carries the WebM initialization segment. Codecs 3 and 4 (full video
    // in WebM) are not handled here.
    if (packet.type === PacketType.END) return;
    if (
      packet.codec !== Codec.OPUS_WEBM &&
      packet.codec !== Codec.OPUS_WEBM_IMAGES
    )
      return;
    const bytes = joiner.push(
      voiceFromPayload(packet.payload, packet.codec),
      afterGap,
    );
    afterGap = false;
    if (!bytes.length) return;
    if (!out) {
      const file =
        option("out") ?? `patio-${packet.streamId.slice(2, 10)}.webm`;
      out = file === "-" ? process.stdout : createWriteStream(file);
      log(`Writing to ${file === "-" ? "stdout" : file}`);
    }
    out.write(bytes);
    log(`packet ${packet.sequence}  ${packet.payload.length} bytes`);
  };

  // Hints. With a link, only hints signed by its key; without one, any
  // author, since every hinted transaction is checked against the session.
  const relays = new SimplePool();
  const lookUp = async (hash: Hex) => {
    for (const wait of LOOKUP_RETRIES_MS) {
      if (ended) return;
      await sleep(wait);
      const tx = await Promise.any(
        lookupClients.map((node) =>
          node
            .getTransaction({ hash })
            .then((found) => found ?? Promise.reject()),
        ),
      ).catch(() => null);
      if (!tx) continue;
      if (isAddressEqual(tx.from, broadcast.session)) take(tx.input, "hint");
      return;
    }
  };
  const subscribeHints = (streamId: Hex) =>
    relays.subscribe(
      HINT_RELAYS,
      {
        kinds: [HINT_KIND],
        "#d": [hintTopic(broadcast.session, streamId)],
        ...(broadcast.hintAuthor ? { authors: [broadcast.hintAuthor] } : {}),
        limit: 0,
      },
      {
        onevent(event) {
          if (broadcast.hintAuthor && event.pubkey !== broadcast.hintAuthor)
            return;
          const hint = parseHint(event.content);
          if (hint?.chainId === network.chainId) void lookUp(hint.hash);
        },
      },
    );
  let hints = broadcast.streamId ? subscribeHints(broadcast.streamId) : null;

  let polls = 0;
  while (!ended) {
    for (const input of await readPool(broadcast.session).catch(() => []))
      take(input, "pool");
    // A public broadcast found by --session names its stream with the first
    // packet; only then can the hints be asked for.
    if (!hints && broadcast.streamId)
      hints = subscribeHints(broadcast.streamId);

    // A late listener starts at the oldest packet it can still see.
    if (next === null && waiting.size) next = Math.min(...waiting.keys());
    while (next !== null && waiting.has(next)) {
      play(waiting.get(next)!);
      waiting.delete(next);
      next++;
      missingSince = null;
    }
    // Something newer is here but `next` never came: move past the hole.
    if (next !== null && waiting.size) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince > GAP_WAIT_MS) {
        log(`missed packet ${next}`);
        next = Math.min(...waiting.keys());
        afterGap = true;
        missingSince = null;
      }
    }

    if (++polls % 8 === 0) {
      const nonce = await client
        .getTransactionCount({ address: broadcast.session })
        .catch(() => broadcast.nonceStart);
      if (nonce > broadcast.nonceStart) ended = true;
    }
    if (!ended) await sleep(POLL_MS);
  }

  for (const sequence of [...waiting.keys()].sort((a, b) => a - b)) {
    afterGap = sequence !== next;
    play(waiting.get(sequence)!);
    next = sequence + 1;
  }
  hints?.close();
  relays.destroy();
  log(
    `The broadcast is over. Packets from the pool: ${found.pool}, from hints: ${found.hint}.`,
  );
  if (out && out !== process.stdout) (out as NodeJS.WritableStream).end();
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import type { Address, Hex } from "viem";

/**
 * Media hints: the broadcaster publishes the hash of each packet it sends on
 * Nostr relays. Some public nodes are several machines behind one address,
 * and a gapped packet may sit on only one of them, so a pool read can come
 * back empty while a lookup by hash still finds the packet.
 *
 * A hint is never trusted as media. The listener fetches the transaction by
 * hash and keeps it only if it comes from the session and decodes as a
 * packet of the right stream.
 */

/** Ephemeral event kind: relays pass it on and do not store it. */
export const HINT_KIND = 20_049;
export const HINT_TAG = "patio-media-hint";
export const HINT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

/** The `#d` tag a broadcast's hints carry. */
export function hintTopic(session: Address, streamId: Hex): string {
  return `${session.toLowerCase()}:${streamId.toLowerCase()}`;
}

export interface Hint {
  chainId: number;
  sequence: number;
  hash: Hex;
}

/** Reads an event's content: `{"v":1,"c":chain,"q":sequence,"h":hash}`. */
export function parseHint(content: string): Hint | null {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (
      value.v !== 1 ||
      !Number.isInteger(value.c) ||
      !Number.isInteger(value.q) ||
      (value.q as number) < 0 ||
      typeof value.h !== "string" ||
      !/^0x[0-9a-f]{64}$/i.test(value.h)
    )
      return null;
    return {
      chainId: value.c as number,
      sequence: value.q as number,
      hash: value.h as Hex,
    };
  } catch {
    return null;
  }
}

"use client";

import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { EmojiReaction } from "./ui/emoji-reaction";

const REACTION_KIND = 20_047;
const REACTION_LIFETIME_MS = 3_400;
const PARTICLES_PER_REACTION = 10;
const REACTION_RELAYS = (
  process.env.NEXT_PUBLIC_PATIO_REACTION_RELAYS ??
  "wss://nos.lol,wss://relay.primal.net,wss://relay.snort.social"
)
  .split(",")
  .map((relay) => relay.trim())
  .filter((relay) => relay.startsWith("wss://"));

const REACTION_EMOJIS = [
  "smiling-face-with-hearts",
  "star-struck",
  "confused-face",
  "pleading-face",
  "grinning-face-with-smiling-eyes",
] as const;

const REACTION_GLYPHS: Record<(typeof REACTION_EMOJIS)[number], string> = {
  "smiling-face-with-hearts": "🥰",
  "star-struck": "🤩",
  "confused-face": "😕",
  "pleading-face": "🥺",
  "grinning-face-with-smiling-eyes": "😄",
};

interface LiveReactionBurst {
  id: string;
  name: (typeof REACTION_EMOJIS)[number];
}

interface ReactionParticleStyle extends CSSProperties {
  "--reaction-x": string;
  "--reaction-drift": string;
  "--reaction-delay": string;
  "--reaction-scale": string;
}

function isReactionName(value: string): value is LiveReactionBurst["name"] {
  return REACTION_EMOJIS.some((name) => name === value);
}

export function LiveReactions({
  streamId,
  active,
  canReact,
}: {
  streamId: string | null;
  active: boolean;
  canReact: boolean;
}) {
  const [bursts, setBursts] = useState<LiveReactionBurst[]>([]);
  const [connected, setConnected] = useState(false);
  const poolRef = useRef<SimplePool | null>(null);
  const secretKeyRef = useRef<Uint8Array | null>(null);
  const seenRef = useRef(new Set<string>());
  const ownEventIdsRef = useRef(new Set<string>());
  const burstTimersRef = useRef(new Set<number>());

  useEffect(() => {
    if (!active || !streamId || REACTION_RELAYS.length === 0) return;
    const pool = new SimplePool({ enableReconnect: true, enablePing: true });
    const ownEventIds = ownEventIdsRef.current;
    const burstTimers = burstTimersRef.current;
    poolRef.current = pool;
    seenRef.current.clear();
    const startedAt = Math.floor(Date.now() / 1_000) - 3;
    const subscription = pool.subscribe(
      REACTION_RELAYS,
      {
        kinds: [REACTION_KIND],
        "#d": [`patio:${streamId}`],
        since: startedAt,
      },
      {
        onevent(event) {
          if (
            seenRef.current.has(event.id) ||
            event.created_at < startedAt ||
            !isReactionName(event.content)
          ) {
            return;
          }
          const reactionName = event.content;
          seenRef.current.add(event.id);
          setConnected(true);
          const sentHere = ownEventIds.has(event.id);
          if (sentHere) ownEventIds.delete(event.id);
          if (!sentHere) {
            setBursts((current) => [
              ...current.slice(-3),
              { id: event.id, name: reactionName },
            ]);
            const timer = window.setTimeout(() => {
              setBursts((current) =>
                current.filter((burst) => burst.id !== event.id),
              );
              burstTimers.delete(timer);
            }, REACTION_LIFETIME_MS);
            burstTimers.add(timer);
          }
        },
        onclose() {
          setConnected(false);
        },
      },
    );
    const connectionCheck = window.setInterval(() => {
      setConnected([...pool.listConnectionStatus().values()].some(Boolean));
    }, 1_500);
    return () => {
      window.clearInterval(connectionCheck);
      subscription.close("Patio stream closed");
      pool.close(REACTION_RELAYS);
      pool.destroy();
      poolRef.current = null;
      ownEventIds.clear();
      for (const timer of burstTimers) window.clearTimeout(timer);
      burstTimers.clear();
    };
  }, [active, streamId]);

  const sendReaction = useCallback(
    (name: string) => {
      const pool = poolRef.current;
      if (!pool || !streamId || !isReactionName(name)) return;
      secretKeyRef.current ??= generateSecretKey();
      const event = finalizeEvent(
        {
          kind: REACTION_KIND,
          created_at: Math.floor(Date.now() / 1_000),
          tags: [
            ["d", `patio:${streamId}`],
            ["client", "patio"],
          ],
          content: name,
        },
        secretKeyRef.current,
      );
      ownEventIdsRef.current.add(event.id);
      if (ownEventIdsRef.current.size > 64) {
        const oldest = ownEventIdsRef.current.values().next().value;
        if (oldest) ownEventIdsRef.current.delete(oldest);
      }
      void Promise.any(pool.publish(REACTION_RELAYS, event))
        .then(() => setConnected(true))
        .catch(() => setConnected(false));
    },
    [streamId],
  );

  if (!active || !streamId) return null;

  return (
    <div className="live-reactions" data-connected={connected}>
      {bursts.length > 0 ? (
        <div className="live-reaction-bursts" aria-live="polite">
          {bursts.flatMap((burst, burstIndex) =>
            Array.from({ length: PARTICLES_PER_REACTION }, (_, index) => {
              const seed = burst.id.charCodeAt(index % burst.id.length) + index;
              const style: ReactionParticleStyle = {
                "--reaction-x": `${8 + ((seed * 17 + index * 9) % 84)}vw`,
                "--reaction-drift": `${((seed * 13) % 25) - 12}vw`,
                "--reaction-delay": `${index * 55 + burstIndex * 35}ms`,
                "--reaction-scale": `${0.72 + (seed % 6) * 0.08}`,
              };
              return (
                <span
                  key={`${burst.id}-${index}`}
                  className="live-reaction-particle"
                  style={style}
                  aria-hidden="true"
                >
                  {REACTION_GLYPHS[burst.name]}
                </span>
              );
            }),
          )}
          <span className="visually-hidden">
            Live reaction:{" "}
            {REACTION_GLYPHS[bursts.at(-1)?.name ?? bursts[0]!.name]}
          </span>
        </div>
      ) : null}
      {canReact ? (
        <EmojiReaction
          className="live-reactions__picker"
          size="sm"
          align="right"
          onReact={sendReaction}
          title={
            connected
              ? "Send a live web reaction"
              : "Send a reaction (web relay connecting)"
          }
        />
      ) : null}
    </div>
  );
}

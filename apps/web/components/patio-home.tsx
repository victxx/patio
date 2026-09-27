"use client";

import { PATIO_NETWORK_PROFILES } from "@patio/config";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { CSSProperties } from "react";

import {
  BrowserEthereumRpc,
  directSessionUrl,
  parseDirectSession,
} from "../lib/direct-hoodi";
import type { PatioNetworkRuntimeConfig } from "../lib/network-runtime";
import {
  fetchPublicBroadcasts,
  parseRegistryAddress,
  type PublicBroadcast,
} from "../lib/patio-registry";
import { DirectTuneConsole } from "./direct-tune-console";

const DIRECTORY_POLL_INTERVAL_MS = 12_000;
const DIRECTORY_GLASS_STYLE = {
  backdropFilter: "blur(16px) saturate(106%)",
  WebkitBackdropFilter: "blur(16px) saturate(106%)",
} satisfies CSSProperties;

function listenerUrl(broadcast: PublicBroadcast): string {
  const url = new URL(
    directSessionUrl(window.location.origin, broadcast.descriptor),
  );
  url.searchParams.set("mode", broadcast.mediaMode);
  return url.toString();
}

function PublicBroadcastDirectory({
  networkConfigs,
}: {
  networkConfigs: readonly PatioNetworkRuntimeConfig[];
}) {
  const [broadcasts, setBroadcasts] = useState<PublicBroadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshing = useRef(false);
  const available = useMemo(
    () =>
      networkConfigs.flatMap((config) => {
        const profile = PATIO_NETWORK_PROFILES[config.networkId];
        const registry = parseRegistryAddress(config.registryAddress);
        return profile.safety.enabled && registry && config.relayRpc.url
          ? [
              {
                rpc: new BrowserEthereumRpc(config.relayRpc),
                profile,
                registry,
              },
            ]
          : [];
      }),
    [networkConfigs],
  );
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    if (available.length === 0) {
      setBroadcasts([]);
      setLoading(false);
      return;
    }
    refreshing.current = true;
    const progress = new Map<number, PublicBroadcast[]>();
    try {
      const results = await Promise.all(
        available.map(async ({ rpc, profile, registry }) => {
          const observerChainId = await rpc.chainId();
          if (observerChainId !== profile.chainId) {
            throw new Error(
              `${profile.name} directory observer is on chain ${observerChainId}.`,
            );
          }
          return fetchPublicBroadcasts(
            rpc,
            registry,
            profile.chainId,
            undefined,
            (found) => {
              progress.set(profile.chainId, found);
              setBroadcasts([...progress.values()].flat());
              setLoading(false);
              setError(null);
            },
          );
        }),
      );
      setBroadcasts(results.flat());
      setError(null);
    } catch {
      setError("Unable to load broadcasts right now.");
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), DIRECTORY_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const hasBroadcasts = broadcasts.length > 0;
  const emptySlots = Math.max(0, 4 - Math.min(broadcasts.length, 4));

  return (
    <>
      <div className="listen-heading">
        <h1 id="listen-title">Listen</h1>
        {hasBroadcasts ? <span>— Join Live!</span> : null}
      </div>
      {loading ? (
        <p className="live-directory-empty" style={DIRECTORY_GLASS_STYLE}>
          Looking for live broadcasts…
        </p>
      ) : !hasBroadcasts ? (
        <div className="live-directory-empty" style={DIRECTORY_GLASS_STYLE}>
          <span>{error ?? "No one is live right now."}</span>
        </div>
      ) : (
        <div className="live-directory-shelf" style={DIRECTORY_GLASS_STYLE}>
          <div className="live-bubbles" aria-label="Live public broadcasts">
            {broadcasts.map((broadcast, index) => {
              const mediaLabel =
                broadcast.mediaMode === "video" ? "Video" : "Audio";
              const wallet = `${broadcast.descriptor.operator.slice(0, 6)}…${broadcast.descriptor.operator.slice(-4)}`;
              return (
                <a
                  key={broadcast.descriptor.streamId}
                  className="live-bubble"
                  href={listenerUrl(broadcast)}
                  aria-label={`${mediaLabel} live by ${wallet}. Join live`}
                  style={
                    {
                      "--live-card-index": index,
                      backdropFilter: "blur(18px) saturate(110%)",
                      WebkitBackdropFilter: "blur(18px) saturate(110%)",
                    } as CSSProperties
                  }
                >
                  <span
                    className="live-bubble__cover"
                    data-mode={broadcast.mediaMode}
                    aria-hidden="true"
                  >
                    <span />
                  </span>
                  <span className="live-bubble__details">
                    <small aria-label={wallet}>
                      <span>{broadcast.descriptor.operator.slice(0, 6)}</span>
                      <span aria-hidden="true">…</span>
                      <span>{broadcast.descriptor.operator.slice(-4)}</span>
                    </small>
                    <strong>{mediaLabel}</strong>
                  </span>
                </a>
              );
            })}
            {Array.from({ length: emptySlots }, (_, index) => (
              <span
                className="live-slot-placeholder"
                aria-hidden="true"
                key={`empty-${index}`}
              />
            ))}
          </div>
          {error ? <p className="simple-error">{error}</p> : null}
        </div>
      )}
    </>
  );
}

export function PatioHome({
  networkConfigs,
  stationFrequency,
}: {
  networkConfigs: readonly PatioNetworkRuntimeConfig[];
  stationFrequency: string;
}) {
  const [selectedBroadcast, setSelectedBroadcast] = useState(false);

  useEffect(() => {
    setSelectedBroadcast(Boolean(parseDirectSession(window.location.search)));
  }, []);

  return (
    <main
      className={`home-page home-page--${selectedBroadcast ? "listening" : "directory"}`}
    >
      <section className="home-listen" aria-labelledby="listen-title">
        {selectedBroadcast ? (
          <>
            <a className="home-back" href="/live">
              ← All live broadcasts
            </a>
            <DirectTuneConsole
              networkConfigs={networkConfigs}
              stationFrequency={stationFrequency}
            />
          </>
        ) : (
          <>
            <PublicBroadcastDirectory networkConfigs={networkConfigs} />
          </>
        )}
      </section>

      {!selectedBroadcast ? (
        <section className="home-broadcast" aria-labelledby="broadcast-title">
          <h2 id="broadcast-title">Broadcast</h2>
          <Link
            className="primary-action"
            href="/live/cast"
            aria-label="Start now"
          >
            <span className="broadcast-cta__label">Start now</span>
          </Link>
        </section>
      ) : null}
    </main>
  );
}

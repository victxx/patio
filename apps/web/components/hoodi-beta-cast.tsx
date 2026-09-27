"use client";

import { useMemo, useRef, useState } from "react";
import { formatEther } from "viem";
import { DirectCastConsole } from "./direct-cast-console";
import { BrowserEthereumRpc } from "../lib/direct-hoodi";
import type { ControlledClassicTest } from "../lib/controlled-classic-test";
import { HOODI_BETA_RPC, type HoodiBetaContext } from "../lib/hoodi-beta";
import type { PatioNetworkRuntimeConfig } from "../lib/network-runtime";

type Caps = { fundingMaxFee: bigint; fundingTip: bigint };
type Review = Parameters<ControlledClassicTest["review"]>[0] & Caps;

/** The same explicit review used by the local Cast host, without a singleton
 * server reservation. The browser retains the signer; no key is sent here. */
export function HoodiBetaCast({
  networkConfigs,
}: {
  networkConfigs: PatioNetworkRuntimeConfig[];
}) {
  const pending = useRef<((caps: Caps) => void) | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const control = useMemo<ControlledClassicTest>(() => {
    const context: HoodiBetaContext = {};
    const rpcConfig = { url: HOODI_BETA_RPC, betaContext: context };
    const read = new BrowserEthereumRpc(rpcConfig);
    return {
      mode: "hoodi-beta",
      rpcConfig,
      async assertReady() {
        if ((await read.chainId()) !== 560048)
          throw Error("Hoodi beta chain mismatch");
      },
      reserve(address) {
        // Called only under Cast's preparation lock, before any funding/signing.
        context.address = address;
        delete context.descriptor;
        delete context.plan;
        delete context.sealHashes;
        return Promise.resolve();
      },
      async review(input) {
        if (
          pending.current ||
          context.address !== input.descriptor.sessionAddress
        )
          throw Error("A different review is already in progress");
        context.descriptor = input.descriptor;
        context.plan = {
          duration: input.duration,
          base: input.plan.feePlan.baseFeePerGasWei.toString(),
          tip: input.priorityFee.toString(),
          funding: input.plan.requiredFundingWei.toString(),
          mediaMode: input.mediaMode ?? "audio",
        };
        const response = await fetch(HOODI_BETA_RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ action: "review", session: context }),
        });
        const body = (await response.json()) as {
          result?: { fundingMaxFee: string; fundingTip: string };
          error?: { message: string };
        };
        if (!response.ok || !body.result)
          throw Error(
            body.error?.message ??
              "Hoodi review unavailable; no funding requested",
          );
        const next = {
          ...input,
          fundingMaxFee: BigInt(body.result.fundingMaxFee),
          fundingTip: BigInt(body.result.fundingTip),
        };
        return new Promise<Caps>((resolve) => {
          pending.current = resolve;
          setReview(next);
        });
      },
      async freeze() {
        // ClassicSession owns irreversible freeze and duplicate exclusion.
        // No server lease or second transport state machine is introduced.
      },
    };
  }, []);
  const enabled = networkConfigs.some(
    (n) => n.networkId === "hoodi" && n.hoodiBeta,
  );
  const reviewDetails =
    enabled && review ? (
      <div className="broadcast-review-proof">
        <p>Your wallet: {review.descriptor.operator}</p>
        <p>Broadcast wallet: {review.descriptor.sessionAddress}</p>
        <p>
          Temporary funding: {formatEther(review.plan.requiredFundingWei)} Hoodi
          ETH.
        </p>
        <p>
          Up to{" "}
          {review.plan.feePlan.windows * review.plan.replacementsPerWindow}{" "}
          packets.
        </p>
        <p>
          Funding gas cap: {formatEther(21_000n * review.fundingMaxFee)} ETH.
          Funding including gas cap:{" "}
          {formatEther(
            review.plan.requiredFundingWei + 21_000n * review.fundingMaxFee,
          )}{" "}
          ETH.
        </p>
        <p>
          {review.visibility === "public"
            ? "Your wallet will first request the public listing, with its network fee shown separately, then funding."
            : "Your wallet will request temporary funding."}{" "}
          Recording starts when you press Start.
        </p>
      </div>
    ) : null;
  const reviewPanel =
    enabled && review ? (
      <section
        className="broadcast-review"
        aria-label="Review broadcast"
        role="status"
      >
        <p>
          {review.mediaMode === "video" ? "Video" : "Audio"} ·{" "}
          {review.visibility === "public" ? "Public" : "Unlisted"}
        </p>
        <p>
          {review.plan.feePlan.affordableDurationSeconds}s ·{" "}
          {formatEther(review.plan.requiredFundingWei).slice(0, 11)} ETH
        </p>
        <button
          type="button"
          className="primary-action"
          onClick={() => {
            const done = pending.current;
            if (!done) return;
            pending.current = null;
            setReview(null);
            done({
              fundingMaxFee: review.fundingMaxFee,
              fundingTip: review.fundingTip,
            });
          }}
        >
          Confirm in wallet
        </button>
      </section>
    ) : null;
  return (
    <DirectCastConsole
      networkConfigs={networkConfigs}
      reviewPanel={reviewPanel}
      reviewDetails={reviewDetails}
      {...(enabled ? { controlledTest: control } : {})}
    />
  );
}

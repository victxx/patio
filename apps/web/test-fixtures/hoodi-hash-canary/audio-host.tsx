"use client";
import { useMemo, useRef, useState } from "react";
import { formatEther } from "viem";
import { DirectCastConsole } from "../../components/direct-cast-console";
import { DirectTuneConsole } from "../../components/direct-tune-console";
import type { ControlledClassicTest } from "../../lib/controlled-classic-test";
import type { PatioNetworkRuntimeConfig } from "../../lib/network-runtime";
const networks: PatioNetworkRuntimeConfig[] = [
  {
    networkId: "hoodi",
    relayRpc: { url: "/api/local-audio" },
    observerRpc: { url: "/api/local-audio" },
    registryAddress: "",
  },
];
async function action<T>(
  action: string,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/api/local-audio", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...fields }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = (await response.json()) as {
    result: T;
    error?: { message: string };
  };
  if (!response.ok || value.error)
    throw Error(value.error?.message ?? "Controlled host unavailable");
  return value.result;
}
type Review = Parameters<ControlledClassicTest["review"]>[0] & {
  id: string;
  fundingMaxFee: bigint;
  fundingTip: bigint;
};
export default function AudioHost({
  listener = false,
}: {
  listener?: boolean;
}) {
  const id = useRef<string | null>(null);
  const resolve = useRef<
    ((caps: { fundingMaxFee: bigint; fundingTip: bigint }) => void) | null
  >(null);
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState(
    "Controlled Hoodi test — QuickNode same-service, not independent propagation. No funding until the exact review is approved.",
  );
  const approving = useRef(false);
  const control = useMemo<ControlledClassicTest>(
    () => ({
      async assertReady() {
        const status = await action<{ chainId: number; provider: string }>(
          "status",
        );
        if (status.chainId !== 560048 || status.provider !== "quicknode")
          throw Error("Wrong controlled host");
      },
      async reserve(address) {
        await action("reserve", { address });
      },
      async review(input) {
        const response = await action<{
          id: string;
          fundingMaxFee: string;
          fundingTip: string;
        }>("review", {
          descriptor: input.descriptor,
          duration: input.duration,
          base: input.plan.feePlan.baseFeePerGasWei.toString(),
          tip: input.priorityFee.toString(),
          funding: input.plan.requiredFundingWei.toString(),
        });
        id.current = response.id;
        const r = {
          ...input,
          id: response.id,
          fundingMaxFee: BigInt(response.fundingMaxFee),
          fundingTip: BigInt(response.fundingTip),
        };
        return new Promise((done) => {
          resolve.current = done;
          setReview(r);
        });
      },
      async freeze() {
        await action("freeze", { id: id.current });
      },
    }),
    [],
  );
  return (
    <>
      <aside className="simple-meta" role="status">
        {message}
      </aside>
      {listener ? (
        <DirectTuneConsole networkConfigs={networks} stationFrequency="88.0" />
      ) : (
        <>
          {review ? (
            <section
              className="simple-meta"
              aria-label="Approve one Hoodi audio test"
            >
              <h2>Review ONE Hoodi audio test — no funds sent yet</h2>
              <p>
                Operator / only return recipient: {review.descriptor.operator}
              </p>
              <p>NEW session: {review.descriptor.sessionAddress}</p>
              <p>
                Session funding: {formatEther(review.plan.requiredFundingWei)}{" "}
                ETH, including margin once. Maximum session exposure:{" "}
                {formatEther(review.plan.feePlan.maximumExposureWei)} ETH.
              </p>
              <p>
                Separate funding gas cap:{" "}
                {formatEther(21_000n * review.fundingMaxFee)} ETH. Total
                operator limit:{" "}
                {formatEther(
                  review.plan.requiredFundingWei +
                    21_000n * review.fundingMaxFee,
                )}{" "}
                ETH.
              </p>
              <p>
                {review.plan.replacementsPerWindow} candidates, one media nonce,
                nominal {review.plan.feePlan.affordableDurationSeconds} seconds.
                Sender and observer: QuickNode. Real Hoodi test ETH, not private
                chain.
              </p>
              <p>
                Media bytes can enter blocks. Balance can remain held. Preserve
                this tab and its in-memory key. Approval triggers ONE reviewed
                wallet funding request; it does not start recording.
              </p>
              <button
                type="button"
                onClick={() =>
                  void (async () => {
                    if (approving.current || !resolve.current) return;
                    approving.current = true;
                    try {
                      await action("approve", { id: review.id });
                      const done = resolve.current;
                      resolve.current = null;
                      setReview(null);
                      setMessage(
                        "Plan approved. Check the exact funding request in Rabby. No recording until Start.",
                      );
                      done({
                        fundingMaxFee: review.fundingMaxFee,
                        fundingTip: review.fundingTip,
                      });
                    } catch {
                      setMessage(
                        "Approval failed; no funding requested. Keep this tab open.",
                      );
                    }
                  })()
                }
              >
                Approve this plan and request funding in Rabby
              </button>
            </section>
          ) : null}
          <DirectCastConsole
            networkConfigs={networks}
            controlledTest={control}
          />
        </>
      )}
    </>
  );
}

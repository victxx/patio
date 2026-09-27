"use client";

import type { PatioNetworkProfile } from "@patio/config";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

import type { BroadcastMediaMode } from "../lib/broadcast-history";
import type { PatioReplacementLineage } from "../lib/patio-replacement-lineage";
import { PatioReplacementLineagePanel } from "./patio-replacement-lineage-panel";

const PROOF_GLASS_STYLE = {
  backdropFilter: "blur(16px) saturate(106%)",
  WebkitBackdropFilter: "blur(16px) saturate(106%)",
} satisfies CSSProperties;

export type EthereumTracePhase =
  | "disconnected"
  | "connected"
  | "preparing"
  | "funding"
  | "ready"
  | "live"
  | "cleaning"
  | "ended"
  | "held";

export type EthereumTraceAction =
  "verify" | "funding" | "media" | "observer" | "cleanup" | "done";

export interface EthereumExecutionProof {
  fundingHash: string | null;
  registryHash: string | null;
  lastMediaHash: string | null;
  sealHash: string | null;
  releaseHash: string | null;
  sweepHash: string | null;
}

interface PublicSessionTrace {
  sessionAddress: string;
  streamId: string;
  nonceStart: string;
  maxPackets: number;
  windows: number;
  replacementsPerWindow: number;
  requiredFundingWei: string;
  mediaMode: BroadcastMediaMode;
  videoCodec: string | null;
}

const TRACE_STEPS = [
  "Network & fees",
  "Session & funding",
  "Media replacement",
  "Independent observer",
  "Cleanup evidence",
] as const;

function shortHex(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function traceIndex(action: EthereumTraceAction): number {
  if (action === "funding") return 1;
  if (action === "media") return 2;
  if (action === "observer") return 3;
  if (action === "cleanup" || action === "done") return 4;
  return 0;
}

function traceProgress(
  phase: EthereumTracePhase,
  packetCount: number,
  maximumPackets: number,
): number {
  if (phase === "ended") return 100;
  if (phase === "cleaning" || phase === "held") return 88;
  if (phase === "live") {
    return 40 + (Math.min(packetCount, maximumPackets) / maximumPackets) * 40;
  }
  if (phase === "ready") return 40;
  if (phase === "funding") return 25;
  if (phase === "preparing") return 12;
  return 2;
}

function codecLabel(session: PublicSessionTrace | null): string {
  if (session?.mediaMode === "video") {
    return `"${session.videoCodec ?? "WEBM_VP8_OPUS"}"`;
  }
  if (session?.mediaMode === "video-beta") return '"OPUS_WEBM_WEBP"';
  return '"OPUS_WEBM"';
}

function TraceCode({ children }: { children: string }) {
  return (
    <details className="trace-code-details">
      <summary>
        <span>Classic flow illustration — not execution evidence</span>
        <span className="trace-code-details__state" aria-hidden="true" />
      </summary>
      <pre>
        <code>{children}</code>
      </pre>
    </details>
  );
}

function TraceStepContent({
  index,
  action,
  session,
  packetCount,
  proof,
  networkProfile,
}: {
  index: number;
  action: EthereumTraceAction;
  session: PublicSessionTrace | null;
  packetCount: number;
  proof: EthereumExecutionProof;
  networkProfile: PatioNetworkProfile;
}) {
  if (index === 0) {
    return (
      <TraceCode>{`const [chainA, chainB, block, tip] = await Promise.all([
  relay.chainId(),
  observer.chainId(),
  relay.latestBaseFee(),
  relay.priorityFee()
]);

assert(chainA === ${networkProfile.chainId} && chainB === ${networkProfile.chainId});
const requiredFundingWei = plan.maximumExposureWei + safetyMarginWei;
assert(requiredFundingWei <= selectedBudgetWei);
assert(requiredFundingWei <= parseEther("0.005"));`}</TraceCode>
    );
  }

  if (index === 1) {
    return (
      <>
        <TraceCode>{`const session = privateKeyToAccount(generatePrivateKey());
const gap = await relay.transactionCount(session.address);

const seals = await signEmptyTransactions({
  nonces: range(gap + 1n, windows)
});
await operator.sendTransaction({
  to: session.address,
  value: requiredFundingWei
});`}</TraceCode>
        {session ? (
          <dl className="trace-values">
            <div>
              <dt>session</dt>
              <dd title={session.sessionAddress}>
                {shortHex(session.sessionAddress)}
              </dd>
            </div>
            <div>
              <dt>nonce windows</dt>
              <dd>
                {session.windows} × {session.replacementsPerWindow}
              </dd>
            </div>
            <div>
              <dt>mode</dt>
              <dd>{session.mediaMode}</dd>
            </div>
            <div>
              <dt>temporary funding</dt>
              <dd>
                {session.requiredFundingWei}{" "}
                {networkProfile.nativeCurrency.symbol}
              </dd>
            </div>
            <div>
              <dt>public registry tx</dt>
              <dd title={proof.registryHash ?? undefined}>
                {proof.registryHash ? shortHex(proof.registryHash) : "unlisted"}
              </dd>
            </div>
            <div>
              <dt>funding tx</dt>
              <dd title={proof.fundingHash ?? undefined}>
                {proof.fundingHash ? shortHex(proof.fundingHash) : "waiting"}
              </dd>
            </div>
          </dl>
        ) : null}
      </>
    );
  }

  if (index === 2) {
    return (
      <>
        <TraceCode>{`${session?.mediaMode === "video" ? "const fragments = fragmentVideoSegment(webmBytes);\n" : ""}const packet = encodePatioPacket({
  codec: ${codecLabel(session)},
  windowIndex,
  sequence,
  payload
});

const rawTx = await classic.sign("media", {
  chainId: ${networkProfile.chainId},
  nonce: gap + 1n + BigInt(windowIndex),
  data: bytesToHex(packet),
  gas: 351720n,
  ...feeLadder[replacementIndex]
}, sequence); // registers hash BEFORE any submission

await classic.send(rawTx);`}</TraceCode>
        <dl className="trace-values">
          <div>
            <dt>packet</dt>
            <dd>
              {packetCount + 1} / {session?.maxPackets ?? "?"}
            </dd>
          </div>
          <div>
            <dt>latest media tx</dt>
            <dd title={proof.lastMediaHash ?? undefined}>
              {proof.lastMediaHash ? shortHex(proof.lastMediaHash) : "waiting"}
            </dd>
          </div>
        </dl>
      </>
    );
  }

  if (index === 3) {
    return (
      <>
        <TraceCode>{`const txpool = await observer.request({
  method: "txpool_contentFrom",
  params: [session.address]
});

assert(flattenTxpoolTransactions(txpool)
  .some(tx => tx.hash === expectedHash));`}</TraceCode>
        <dl className="trace-values">
          <div>
            <dt>node B confirmed</dt>
            <dd>
              {packetCount} / {session?.maxPackets ?? "?"} packets
            </dd>
          </div>
          <div>
            <dt>stream</dt>
            <dd title={session?.streamId}>
              {session ? shortHex(session.streamId) : "waiting"}
            </dd>
          </div>
        </dl>
      </>
    );
  }

  return (
    <>
      <TraceCode>{`classic.beginCleanup(); // irreversible media freeze
for (const emptySeal of stillNeededSeals) {
  const hash = await classic.send(emptySeal);
  await observerConfirms(hash);
}
await classic.send(emptyRelease); // nonce g, only if still available
await classic.reconcile(); // identify canonical winners, including media
const sweepHash = await classic.sweep(); // sign once from current balance
if (sweepHash) await classic.confirmSweep();`}</TraceCode>
      <dl className="trace-values">
        {[
          ["latest seal", proof.sealHash],
          ["release", proof.releaseHash],
          ["sweep", proof.sweepHash],
        ].map(([label, hash]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={hash ?? undefined}>
              {hash
                ? shortHex(hash)
                : action === "done"
                  ? "unknown"
                  : "waiting"}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function EthereumExecutionPanel({
  open,
  onOpenChange,
  phase,
  action,
  session,
  packetCount,
  proof,
  replacementLineage,
  networkProfile,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phase: EthereumTracePhase;
  action: EthereumTraceAction;
  session: PublicSessionTrace | null;
  packetCount: number;
  proof: EthereumExecutionProof;
  replacementLineage: PatioReplacementLineage;
  networkProfile: PatioNetworkProfile;
  children?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const activeIndex = traceIndex(action);
  const progress = traceProgress(phase, packetCount, session?.maxPackets ?? 1);
  const shellTransition = reduceMotion
    ? { duration: 0 }
    : {
        type: "tween" as const,
        duration: 0.4,
        ease: [0.22, 1, 0.36, 1] as const,
      };
  const contentTransition = reduceMotion ? { duration: 0 } : { duration: 0.22 };
  const descriptions = [
    `Two ${networkProfile.name} providers verify live fees, the selected budget and Patio's hard 0.005 ${networkProfile.nativeCurrency.symbol} cap.`,
    "The session keeps its signing inventory in memory. New classic sessions defer the single return signature until reconciliation.",
    "Each media packet is signed and sent as a queued replacement transaction.",
    "A second provider confirms the same transaction independently in its mempool.",
    "Observed seals do not exclude older media globally. Classic closure requires canonical winner reconciliation; a confirmed return does not erase media inclusion.",
  ] as const;

  return (
    <AnimatePresence initial={false} mode="sync">
      {!open ? (
        <motion.button
          key="proof-toggle"
          className="ethereum-trace-toggle"
          type="button"
          aria-expanded="false"
          aria-controls="ethereum-execution-panel"
          onClick={() => onOpenChange(true)}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
          transition={shellTransition}
          style={{ ...PROOF_GLASS_STYLE, transformOrigin: "center" }}
        >
          Proof
        </motion.button>
      ) : (
        <motion.aside
          key="proof-panel"
          id="ethereum-execution-panel"
          className="ethereum-trace-panel"
          aria-label="Live Ethereum execution"
          initial={
            reduceMotion
              ? false
              : {
                  opacity: 0,
                  scale: 0.92,
                }
          }
          animate={{
            opacity: 1,
            x: 0,
            scale: 1,
          }}
          exit={
            reduceMotion
              ? { opacity: 0 }
              : {
                  opacity: 0,
                  scale: 0.92,
                }
          }
          transition={shellTransition}
          style={{ ...PROOF_GLASS_STYLE, transformOrigin: "center" }}
        >
          <button
            className="trace-collapse"
            type="button"
            aria-label="Collapse Ethereum proof"
            onClick={() => onOpenChange(false)}
          >
            <span aria-hidden="true">▸</span>
          </button>

          <div className="trace-panel-content">
            <header className="trace-header">
              <div className="trace-header__title">
                <h2>
                  {networkProfile.family === "ethereum"
                    ? `Ethereum ${networkProfile.name} Proof`
                    : networkProfile.id === "gnosis"
                      ? "Gnosis Mainnet Proof"
                      : `Gnosis ${networkProfile.name} Proof`}
                </h2>
              </div>
            </header>

            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={contentTransition}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.section
                  key={`${activeIndex}-${action}`}
                  className="trace-active-step"
                  aria-live="polite"
                  initial={reduceMotion ? false : { opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  layout
                  transition={contentTransition}
                >
                  <div className="trace-step__title">
                    <h3>{TRACE_STEPS[activeIndex]}</h3>
                    <span>{activeIndex + 1}/5</span>
                  </div>
                  <div
                    className="trace-progress"
                    role="progressbar"
                    aria-label="Ethereum execution progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress)}
                  >
                    <motion.span
                      initial={false}
                      animate={{ width: `${progress}%` }}
                      transition={contentTransition}
                    />
                  </div>
                  <div className="trace-teleprompter" aria-live="polite">
                    <motion.p
                      key={activeIndex}
                      className="trace-teleprompter__line"
                      initial={reduceMotion ? false : { opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={contentTransition}
                    >
                      {descriptions[activeIndex]}
                    </motion.p>
                  </div>
                  <TraceStepContent
                    index={activeIndex}
                    action={action}
                    session={session}
                    packetCount={packetCount}
                    proof={proof}
                    networkProfile={networkProfile}
                  />
                  <PatioReplacementLineagePanel
                    lineage={replacementLineage}
                    networkProfile={networkProfile}
                  />
                </motion.section>
              </AnimatePresence>
              {children}
            </motion.div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

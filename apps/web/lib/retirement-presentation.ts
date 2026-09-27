import type { SingleNonceTransport } from "./single-nonce-transport";
import { formatEther } from "viem";

type Snapshot = ReturnType<SingleNonceTransport["snapshot"]>;
/** Uses only controller evidence; never fetches missing accounting fields. */
export function retirementPresentation(snapshot: Snapshot) {
  const safetyFailed =
    snapshot.state === "safety-failed" ||
    snapshot.events.some(
      (e) =>
        e.stage === "safety-failed" ||
        e.errorClass === "canonical-media-inclusion",
    );
  const invalidated =
    snapshot.events.some(
      (e) => e.errorClass === "canonical-evidence-invalidated",
    ) && snapshot.state === "held-close-uncertain";
  const receiptFor = (hash?: string) =>
    invalidated
      ? undefined
      : snapshot.receipts.find(
          (r) => r.transactionHash === hash && r.status === "0x1",
        );
  const close = receiptFor(snapshot.closeHash);
  const sweep = receiptFor(snapshot.sweepHash);
  const complete =
    !safetyFailed && snapshot.state === "complete" && Boolean(close && sweep);
  const labels: Record<Snapshot["state"], string> = {
    prepared: "Prepared — not broadcasting",
    broadcasting: "Recording audio",
    "media-frozen": "Recording stopped",
    "close-submitting": "Closing session",
    "close-pending": "Close pending verification",
    "close-included": "Media nonce retired",
    "sweep-submitting": "Returning remaining balance",
    complete: "Session complete",
    "held-before-close": "Close needs attention",
    "held-close-uncertain": "Close pending verification",
    "held-after-close": "Return needs attention",
    "sweep-pending": "Return pending verification",
    "safety-failed": "Safety failure",
  };
  const cost = (receipt: typeof close) =>
    receipt
      ? formatEther(
          BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice),
        ) + " private ETH"
      : "Unknown";
  return {
    message: safetyFailed
      ? "Safety failure"
      : snapshot.state === "complete" && !complete
        ? "Completion needs verification"
        : labels[snapshot.state],
    complete,
    needsAttention:
      safetyFailed ||
      snapshot.state.startsWith("held") ||
      snapshot.state === "sweep-pending" ||
      (snapshot.state === "complete" && !complete),
    closeVerified: Boolean(close) && !invalidated,
    returnVerified: Boolean(sweep) && Boolean(close) && !invalidated,
    funding: snapshot.funded
      ? `At least ${formatEther(BigInt(snapshot.plan.requiredExposure))} private ETH verified`
      : "Not verified",
    closeGas: cost(close),
    sweepGas: cost(sweep),
    // These facts are not in the current transport snapshot. Never derive them
    // by assuming no other transfers or treating max-fee reserves as spending.
    returned: "Unknown — transferred value not retained in controller evidence",
    residual: "Unknown — no post-return balance observation retained",
    fundingGas: "Unknown — paid separately by the fixture operator",
  };
}

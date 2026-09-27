import type { SingleNonceTransport } from "../../lib/single-nonce-transport";

/** Independent allowlist for the local bridge's metadata file. Never copy
 * arbitrary fields from a browser POST, even from this owned fixture. */
export function compactFixtureSnapshot(
  input: ReturnType<SingleNonceTransport["snapshot"]>,
) {
  if (
    input.signatures.length > 22 ||
    input.events.length > 128 ||
    input.receipts.length > 2
  )
    throw new Error("Fixture metadata bounds exceeded");
  const d = input.descriptor;
  return {
    mode: input.mode,
    descriptor: {
      version: d.version,
      chainId: d.chainId,
      operator: d.operator,
      sessionAddress: d.sessionAddress,
      streamId: d.streamId,
      nonceStart: d.nonceStart,
      ...(d.transportMode === undefined
        ? {}
        : { transportMode: d.transportMode }),
    },
    state: input.state,
    g: input.g,
    m: input.m,
    s: input.s,
    frozenAtMonotonicMs: input.frozenAtMonotonicMs,
    capacity: input.capacity,
    funded: input.funded,
    fundingAttempted: input.fundingAttempted,
    closeHash: input.closeHash,
    sweepHash: input.sweepHash,
    signatures: input.signatures.map((s) => ({
      role: s.role,
      nonce: s.nonce,
      hash: s.hash,
      ...(s.index === undefined ? {} : { index: s.index }),
      maxFee: s.maxFee,
      tip: s.tip,
    })),
    plan: {
      capacity: input.plan.capacity,
      mediaFees: input.plan.mediaFees.slice(0, 20),
      mediaTips: input.plan.mediaTips.slice(0, 20),
      requiredExposure: input.plan.requiredExposure,
      closeReserve: input.plan.closeReserve,
      sweepReserve: input.plan.sweepReserve,
      estimatedDurationSeconds: input.plan.estimatedDurationSeconds,
    },
    receipts: input.receipts.map((r) => ({
      transactionHash: r.transactionHash,
      blockHash: r.blockHash,
      blockNumber: r.blockNumber,
      status: r.status,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice,
    })),
    events: input.events.map((e) => ({
      stage: e.stage,
      atMonotonicMs: e.atMonotonicMs,
      ...(e.role ? { role: e.role } : {}),
      ...(e.hash ? { hash: e.hash } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
    })),
  };
}

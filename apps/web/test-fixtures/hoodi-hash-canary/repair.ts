/** Targeted in-process reconciliation. No key parameter, no raw transactions,
 * no new account/controller, no change to Permit.assertSign or per-operation guards. */
import type { Hex } from "viem";
import type { ClassicSession, ClassicRpc } from "../../lib/classic-session";
import { observeFunding, type PreMediaCancellation } from "./cancellation";
import { CHAIN, reviewId, type Review, type Permit } from "./core";

export type Recognition = {
  reviewId: Hex;
  fundings: readonly { hash: Hex; nonce: bigint; value: bigint }[];
};
type Context = {
  review: Review;
  session: ClassicSession;
  permit: Permit;
  read: ClassicRpc;
  cancellation: Pick<PreMediaCancellation, "claimed" | "record">;
  report: Record<string, unknown>;
  isBusy: () => boolean;
  setBusy: (value: boolean) => void;
  setPhase: (value: string) => void;
  detachPreviousEntry: () => void;
  executeOriginal: () => Promise<void>;
  persist: () => void;
};
type Block = { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex };

export function assertIdleUnsigned(c: Context, authorization: Recognition) {
  if (
    reviewId(c.review) !== authorization.reviewId ||
    c.review.chainId !== CHAIN ||
    c.review.sender !== "chainstack" ||
    c.review.candidates !== 5 ||
    c.review.cadenceMs !== 3000 ||
    c.review.g !== 0 ||
    c.review.m !== 1 ||
    c.review.sweepNonce !== 2 ||
    c.session.input.account.address.toLowerCase() !==
      c.review.session.toLowerCase() ||
    c.session.input.operator.toLowerCase() !==
      c.review.operator.toLowerCase() ||
    c.session.input.attemptId !== authorization.reviewId ||
    c.session.input.plan.windows !== 1 ||
    c.session.input.replacements !== 5 ||
    c.session.signatures.length ||
    c.session.frozen ||
    c.session.cleanupStarted ||
    c.session.sweepClaimed ||
    c.permit.signatureAttempted ||
    c.cancellation.claimed ||
    c.cancellation.record ||
    c.isBusy() ||
    c.report.publicSends !== 0
  )
    throw new Error(
      "Repair requires exact approved plan and completely idle unsigned instance",
    );
  c.permit.assertCancellationAvailable(c.session); // private in-flight/send guards; no mutation
}

export async function reconcileRecognizedFunding(
  c: Context,
  authorization: Recognition,
) {
  const unique = new Map<Hex, Recognition["fundings"][number]>();
  for (const f of authorization.fundings) {
    const existing = unique.get(f.hash);
    if (existing && (existing.value !== f.value || existing.nonce !== f.nonce))
      throw new Error("Conflicting duplicate funding metadata");
    unique.set(f.hash, f);
  }
  if (!unique.size || unique.size > 2)
    throw new Error("Only the explicitly recognized fundings");
  const transfers = [];
  for (const f of unique.values()) {
    const observation = await observeFunding(c.read, f.hash, c.review.session);
    const tx = await c.read.transaction(f.hash);
    if (
      !tx ||
      observation.value !== f.value ||
      BigInt(tx.nonce) !== f.nonce ||
      observation.operatorGas === null
    )
      throw new Error("Recognized funding identity/value/gas unavailable");
    transfers.push({
      ...observation,
      operatorNonce: f.nonce,
      fundingEnvelopeDiscrepancyRecognized: true,
    });
  }
  const head = await c.read.request<Block>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const [balance, nonce, pending, code, recipientCode] = await Promise.all([
    c.read.request<Hex>("eth_getBalance", [c.review.session, head.number]),
    c.read.request<Hex>("eth_getTransactionCount", [
      c.review.session,
      head.number,
    ]),
    c.read.request<Hex>("eth_getTransactionCount", [
      c.review.session,
      "pending",
    ]),
    c.read.request<Hex>("eth_getCode", [c.review.session, head.number]),
    c.read.request<Hex>("eth_getCode", [c.review.operator, head.number]),
  ]);
  const totalReceivedWei = transfers.reduce((sum, f) => sum + f.value, 0n);
  const operatorGasWei = transfers.reduce((sum, f) => sum + f.operatorGas!, 0n);
  const base = BigInt(head.baseFeePerGas);
  if (
    BigInt(balance) !== totalReceivedWei ||
    totalReceivedWei < c.review.fundingWei ||
    BigInt(nonce) !== 0n ||
    BigInt(pending) !== 0n ||
    code !== "0x" ||
    recipientCode !== "0x" ||
    Date.now() / 1000 - Number(BigInt(head.timestamp)) > 300
  )
    throw new Error("Recognized balance/nonce/code/head changed");
  if (
    c.review.mediaFees.some((cap, i) => base + c.review.mediaTips[i]! > cap) ||
    base + c.review.cleanupTip > c.review.cleanupFee
  )
    throw new Error("Current fees exceed unchanged approved plan; no increase");
  const canonical = await c.read.request<Block>("eth_getBlockByNumber", [
    head.number,
    false,
  ]);
  if (canonical.hash !== head.hash)
    throw new Error("Snapshot changed; no activation");
  return {
    transfers,
    totalReceivedWei,
    operatorGasWei,
    block: head.number,
    blockHash: head.hash,
    originalPlannedFundingWei: c.review.fundingWei,
    originalMaximumSessionGasWei: c.review.maximumSessionGasWei,
    excessIsNotAdditionalBudget: true,
    reviewedAt: new Date().toISOString(),
  };
}

/** This installs no signing function. It retains the original session and permit.
 * Original CLI entries are detached before async reconciliation; one start claim. */
export function installRepair(c: Context, authorization: Recognition) {
  assertIdleUnsigned(c, authorization);
  if (c.report.liveFundingRepair) throw new Error("Repair already installed");
  c.detachPreviousEntry();
  const state = {
    version: "recognized-funding-v1",
    installed: true,
    startClaimed: false,
    previousEntriesDetached: true,
    originalControllerRetained: true,
    expectedReviewId: authorization.reviewId,
    status: "installed-not-started",
  };
  c.report.liveFundingRepair = state;
  let recognized:
    Awaited<ReturnType<typeof reconcileRecognizedFunding>> | undefined;
  let accounting: unknown = c.report.accounting;
  // Original execute() computes streaming gas/return/residual. Correct ONLY its
  // funding summary at assignment, so no transient false single-funding report.
  Object.defineProperty(c.report, "accounting", {
    enumerable: true,
    configurable: false,
    get: () => accounting,
    set: (value: Record<string, unknown>) => {
      if (!recognized) throw new Error("No recognized funding for accounting");
      const gas = value.sessionGasWei,
        returned = value.returnedWei,
        residual = value.residualWei;
      accounting = {
        ...value,
        fundingWei: recognized.totalReceivedWei,
        operatorFundingGasWei: recognized.operatorGasWei,
        reconciles:
          typeof gas === "bigint" &&
          typeof returned === "bigint" &&
          typeof residual === "bigint"
            ? recognized.totalReceivedWei === gas + returned + residual
            : null,
      };
    },
  });
  c.persist();
  return {
    status: () => ({
      ...state,
      session: c.review.session,
      signatures: c.session.signatures.length,
      signatureAttempted: c.permit.signatureAttempted,
      publicSends: c.report.publicSends,
      busy: c.isBusy(),
    }),
    async revalidate() {
      if (state.startClaimed)
        throw new Error("Already activated; reconciliation only");
      assertIdleUnsigned(c, authorization);
      recognized = await reconcileRecognizedFunding(c, authorization);
      assertIdleUnsigned(c, authorization);
      c.report.recognizedFunding = recognized;
      state.status = "revalidated-not-started";
      c.persist();
      return recognized;
    },
    async start() {
      if (state.startClaimed)
        throw new Error("Single activation already claimed");
      assertIdleUnsigned(c, authorization);
      state.startClaimed = true;
      state.status = "revalidating-before-start";
      c.persist();
      try {
        recognized = await reconcileRecognizedFunding(c, authorization);
        assertIdleUnsigned(c, authorization);
        c.report.recognizedFunding = recognized;
        const first = c.session.financial.find((f) => f.role === "funding");
        const actual = recognized.transfers.find((f) => f.hash === first?.hash);
        if (
          !first ||
          !actual ||
          first.value !== actual.value ||
          first.to.toLowerCase() !== actual.to.toLowerCase()
        )
          throw new Error(
            "Original financial request does not match its verified transfer",
          );
        c.report.recognizedFundingOriginalAttempt = { ...first };
        first.state = "confirmed"; // exact receipt/origin/value above, not a fabricated funding
        c.session.held = false;
        c.permit.confirmFunding(c.session); // original private approval + funding claim still required
        c.setPhase("funded-not-started");
        state.status = "executing-original-controller";
        c.persist();
        await c.executeOriginal();
        state.status = "original-execution-returned";
      } catch (e) {
        c.session.freeze();
        c.session.held = true;
        c.setPhase("held");
        state.status = "held-no-retry";
        c.report.liveRepairFailure =
          e instanceof Error ? e.message : "Unknown outcome";
        throw new Error("B3 held; preserve instance and reconcile read-only");
      } finally {
        c.setBusy(false);
        c.persist();
      }
    },
  };
}

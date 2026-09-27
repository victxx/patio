/** Offline receipt doubles + synthetic fixture key. No RPC network or funded key. */
import { expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { ClassicRpc } from "../../lib/classic-session";
import { installRepair, type Recognition } from "./repair";
import { installCanonicalFundingRead } from "./canonical-funding-read";
import type { LabRpc } from "./rpc";
import {
  CHAIN,
  OPERATOR,
  Permit,
  mediaTx,
  planFor,
  retainedSession,
  reviewId,
  type Review,
} from "./core";
const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
it("pins only the two historical funding blocks to Alchemy; all other reads stay on Chainstack", async () => {
  const original = vi.fn(() => Promise.resolve("original"));
  const read = {
    provider: "chainstack",
    request: original,
  } as unknown as LabRpc;
  const canonicalRequest = vi.fn(() =>
    Promise.resolve({
      number: "0x386d98",
      hash: "0x2459ec9680d8017bad831e1d4f77f08479a6384c3cbe4f2d00e356f3bc594230",
    }),
  );
  const canonical = {
    provider: "alchemy",
    chainId: () => Promise.resolve(560048),
    request: canonicalRequest,
  } as unknown as LabRpc;
  const report = {
    liveFundingRepair: { installed: true, startClaimed: false },
    publicSends: 0,
  };
  installCanonicalFundingRead(read, canonical, report);
  await read.request("eth_getBlockByNumber", ["0x386d98", false]);
  expect(canonicalRequest).toHaveBeenCalledTimes(1);
  await read.request("eth_getTransactionByHash", [h1]);
  await read.request("eth_getBlockByNumber", ["latest", false]);
  expect(original).toHaveBeenCalledTimes(2);
  await expect(
    read.request("eth_getBlockByNumber", ["0x386d98", true]),
  ).rejects.toThrow();
  expect(() => installCanonicalFundingRead(read, canonical, report)).toThrow();
});
const hex = (x: number | bigint): Hex => `0x${x.toString(16)}`;
const h1: Hex = `0x${"aa".repeat(32)}`,
  h2: Hex = `0x${"bb".repeat(32)}`,
  blockHash: Hex = `0x${"cc".repeat(32)}`;
function fixture(count = 2) {
  const fees = planFor(1_000_000n, 100_000_000n);
  const review: Review = {
    schema: 1,
    chainId: CHAIN,
    sender: "chainstack",
    readers: ["chainstack", "alchemy", "drpc"],
    operator: OPERATOR,
    session: account.address,
    streamId: `0x${"ab".repeat(16)}`,
    g: 0,
    m: 1,
    sweepNonce: 2,
    candidates: 5,
    cadenceMs: 3000,
    fundingWei: fees.returnPlan.requiredFundingWei,
    maximumSessionGasWei: fees.returnPlan.maximumExposureWei,
    marginWei: fees.returnPlan.safetyMarginWei,
    mediaFees: fees.plan.mediaFeeLadderWei,
    mediaTips: fees.plan.mediaPriorityFeeLadderWei,
    cleanupFee: fees.plan.sealMaxFeePerGasWei,
    cleanupTip: fees.plan.sealPriorityFeePerGasWei,
    mediaGas: 351720n,
    sweepGas: 21000n,
    fundingGas: 21000n,
    fundingFeeCap: 102000000n,
    fundingTip: 100000000n,
    quotedAt: Date.now(),
    block: "0x10",
    blockHash,
  };
  const author: Recognition = {
    reviewId: reviewId(review),
    fundings: [
      { hash: h1, nonce: 47n, value: review.fundingWei },
      ...(count === 2
        ? [{ hash: h2, nonce: 48n, value: review.fundingWei }]
        : []),
    ],
  };
  const read = {
    chainId: () => Promise.resolve(CHAIN),
    receipt: (h: Hex) =>
      Promise.resolve({
        transactionHash: h,
        blockNumber: "0x10",
        blockHash,
        status: "0x1",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x1",
      }),
    transaction: (h: Hex) =>
      Promise.resolve({
        hash: h,
        from: OPERATOR,
        to: account.address,
        nonce: h === h1 ? "0x2f" : "0x30",
        value: hex(review.fundingWei),
        input: "0x",
        type: "0x0",
      }),
    request: async (method: string) => {
      await Promise.resolve();
      if (method === "eth_getBlockByNumber")
        return {
          number: "0x10",
          hash: blockHash,
          timestamp: hex(Math.floor(Date.now() / 1000)),
          baseFeePerGas: "0x1",
        };
      if (method === "eth_getBalance")
        return hex(review.fundingWei * BigInt(count));
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_getCode") return "0x";
      throw new Error("Unexpected RPC");
    },
  } as unknown as ClassicRpc;
  const permit = new Permit(review),
    session = retainedSession(account, review, fees, read, read, permit);
  permit.approve(reviewId(review), String(review.fundingWei));
  permit.claimFunding(CHAIN, OPERATOR, account.address, review.fundingWei);
  session.financial.push({
    id: "original",
    role: "funding",
    to: account.address,
    value: review.fundingWei,
    state: "hash-received",
    hash: h1,
  });
  session.held = true;
  let busy = false,
    phase = "held";
  const report: Record<string, unknown> = { publicSends: 0 };
  const context = {
    review,
    session,
    permit,
    read,
    cancellation: { claimed: false, record: null },
    report,
    isBusy: () => busy,
    setBusy: (v: boolean) => {
      busy = v;
    },
    setPhase: (v: string) => {
      phase = v;
    },
    detachPreviousEntry: vi.fn(),
    persist: vi.fn(),
    executeOriginal: vi.fn(async () => {
      if (phase !== "funded-not-started") throw new Error("Wrong phase");
      await session.sign("media", mediaTx(review, 0)); // synthetic fixture signature, no sends
      report.accounting = {
        fundingWei: review.fundingWei,
        sessionGasWei: 10n,
        returnedWei: review.fundingWei * BigInt(count) - 13n,
        residualWei: 3n,
        operatorFundingGasWei: 21000n,
      };
    }),
  };
  return { context, author, review, session, permit, report };
}
it("recognizes one confirmed legacy funding, original permit still gates signing", async () => {
  const f = fixture(1),
    r = installRepair(f.context, f.author);
  expect(() => f.permit.assertSign()).toThrow();
  await r.revalidate();
  expect(() => f.permit.assertSign()).toThrow();
  await r.start();
  expect(f.session.signatures).toHaveLength(1);
  expect(f.context.detachPreviousEntry).toHaveBeenCalledTimes(1);
});
it("deduplicates two actual receipts, does not forge one funding or grow the plan", async () => {
  const f = fixture(),
    original = reviewId(f.review);
  const r = installRepair(f.context, {
    ...f.author,
    fundings: [...f.author.fundings, f.author.fundings[0]!],
  });
  const checked = await r.revalidate();
  expect(checked.transfers).toHaveLength(2);
  expect(checked.totalReceivedWei).toBe(f.review.fundingWei * 2n);
  expect(checked.operatorGasWei).toBe(42000n);
  await r.start();
  expect(reviewId(f.review)).toBe(original);
  expect(f.session.financial).toHaveLength(1);
  expect(f.session.financial[0]!.value).toBe(f.review.fundingWei);
  expect(f.report.accounting).toMatchObject({
    fundingWei: f.review.fundingWei * 2n,
    operatorFundingGasWei: 42000n,
    reconciles: true,
  });
});
it("blocks ANY previous signature, including a cleanup signature, before detaching entries", () => {
  const f = fixture();
  f.session.signatures.push({
    role: "release",
    hash: h1,
    nonce: 0n,
    index: 0,
    window: -1,
    gas: 21000n,
    maxFee: 1n,
    tip: 1n,
    signedAt: 0,
    outcome: "signed",
  });
  expect(() => installRepair(f.context, f.author)).toThrow();
  expect(f.context.detachPreviousEntry).not.toHaveBeenCalled();
});
it("double activation executes the retained controller once; cannot reinstall", async () => {
  const f = fixture(),
    r = installRepair(f.context, f.author);
  const result = await Promise.allSettled([r.start(), r.start()]);
  expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(f.context.executeOriginal).toHaveBeenCalledTimes(1);
  expect(() => installRepair(f.context, f.author)).toThrow();
});
it("revalidation failure retains the same instance and performs no signatures or retries", async () => {
  const f = fixture(),
    r = installRepair(f.context, f.author);
  f.context.read.chainId = () => Promise.resolve(1);
  await expect(r.start()).rejects.toThrow();
  expect(f.session.signatures).toHaveLength(0);
  expect(f.session.frozen).toBe(true);
  await expect(r.start()).rejects.toThrow();
  expect(f.context.executeOriginal).not.toHaveBeenCalled();
});

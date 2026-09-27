/** OFFLINE: controlled RPC doubles and deterministic fixture signatures; no public account. */
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, type Hex } from "viem";
import { readFileSync } from "node:fs";
import {
  FundingLedger,
  observeFunding,
  PreMediaCancellation,
  cancellationId,
} from "./cancellation";
import {
  CHAIN,
  OPERATOR,
  Permit,
  planFor,
  retainedSession,
  reviewId,
  type Review,
} from "./core";
import { HOODI_READ_METHODS } from "../../lib/hoodi-provider-pool";
import type { ClassicRpc } from "../../lib/classic-session";

const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
const hash: Hex = `0x${"ab".repeat(32)}`,
  blockHash: Hex = `0x${"cd".repeat(32)}`;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
function fixture() {
  const fees = planFor(1_000_000n, 100_000_000n);
  const review: Review = {
    schema: 1,
    readers: ["chainstack", "alchemy", "drpc"],
    streamId: `0x${"ab".repeat(16)}`,
    g: 0,
    m: 1,
    sweepNonce: 2,
    candidates: 5,
    cadenceMs: 3000,
    chainId: CHAIN,
    session: account.address,
    operator: OPERATOR,
    sender: "chainstack",
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
    blockHash,
    quotedAt: Date.now(),
    block: "0x10",
  };
  let chain = CHAIN,
    nonce = "0x0",
    pending = "0x0",
    code = "0x",
    balance = 3_000_000_000_000_000n;
  let receiptStatus = "0x1",
    canonical = blockHash,
    fee = 1_000_000n;
  const tx = {
    hash,
    from: OPERATOR,
    to: account.address,
    nonce: "0x1",
    value: hex(balance),
    input: "0x",
  };
  const receipt = {
    transactionHash: hash,
    status: receiptStatus,
    blockNumber: "0x10",
    blockHash,
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
  };
  const read = {
    chainId: vi.fn(() => Promise.resolve(chain)),
    transaction: vi.fn(() => Promise.resolve(tx)),
    receipt: vi.fn(() =>
      Promise.resolve({ ...receipt, status: receiptStatus }),
    ),
    balance: vi.fn(() => Promise.resolve(balance)),
    estimateGas: vi.fn(() => Promise.resolve(21000n)),
    request: vi.fn(async (method: string, params: unknown[]) => {
      await Promise.resolve();
      if (method === "eth_getBlockByNumber")
        return {
          number: "0x10",
          hash: canonical,
          timestamp: hex(Math.floor(Date.now() / 1000)),
          baseFeePerGas: hex(fee),
        };
      if (method === "eth_getBalance") return hex(balance);
      if (method === "eth_getTransactionCount")
        return params[1] === "pending" ? pending : nonce;
      if (method === "eth_getCode") return code;
      if (method === "eth_maxPriorityFeePerGas") return "0x1";
      throw new Error("Unexpected method");
    }),
  } as unknown as ClassicRpc;
  const permit = new Permit(review);
  const session = retainedSession(account, review, fees, read, read, permit);
  let failSend = false;
  const signer = vi.fn(account.signTransaction);
  const saved: unknown[] = [];
  const send = vi.fn(async (raw: Hex, guard: (raw: Hex) => Promise<void>) => {
    expect(cancel.record?.outcome).toBe("signed");
    expect(saved.length).toBeGreaterThan(0);
    await guard(raw);
    if (failSend) throw new Error("timeout");
    return keccak256(raw);
  });
  const cancel = new PreMediaCancellation({
    account: { ...account, signTransaction: signer },
    review,
    read,
    assertIdleUnsigned: () => permit.assertCancellationAvailable(session),
    claimExclusive: () => permit.claimCancellation(session),
    send,
    persist: () => saved.push(cancel.record ? { ...cancel.record } : null),
  });
  return {
    cancel,
    signer,
    send,
    session,
    permit,
    read,
    tx,
    review,
    saved,
    change: (field: string) => {
      if (field === "chain") chain = 1;
      if (field === "nonce") nonce = "0x1";
      if (field === "pending") pending = "0x1";
      if (field === "code") code = "0x1234";
      if (field === "balance") balance--;
      if (field === "reverted") receiptStatus = "0x0";
      if (field === "reorg") canonical = `0x${"ef".repeat(32)}`;
      if (field === "fees") fee *= 10n;
      if (field === "timeout") failSend = true;
    },
  };
}

describe("future-process pre-media cancellation (offline only)", () => {
  it("quotes exact real funding without changing original budget, signs nothing", async () => {
    const f = fixture(),
      o = await observeFunding(f.read, hash, account.address);
    const ledger = new FundingLedger(f.review.fundingWei);
    ledger.observe(o);
    expect(ledger.ready).toBe(false);
    ledger.recognize(hash, String(o.value));
    expect(ledger.ready).toBe(true);
    expect(ledger.plannedWei).toBe(f.review.fundingWei);
    const q = await f.cancel.quote(hash);
    expect(q.balance).toBe(o.value);
    expect(q.returnValueWei + q.maximumCostWei).toBe(o.value);
    expect(f.signer).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("requires separate exact cancellation approval, not streaming approval", async () => {
    const f = fixture(),
      q = await f.cancel.quote(hash);
    await expect(
      f.cancel.execute("streaming-approval", String(q.maximumCostWei)),
    ).rejects.toThrow();
    await expect(f.cancel.execute(cancellationId(q), "1")).rejects.toThrow();
    expect(f.signer).not.toHaveBeenCalled();
  });
  it("returns actual balance less gas, nonce0/operator only, metadata before send; locks streaming permanently", async () => {
    const f = fixture();
    f.session.freeze(); // pre-exposure freeze is never reset to execute this DIFFERENT cancellation
    const q = await f.cancel.quote(hash);
    await f.cancel.execute(cancellationId(q), String(q.maximumCostWei));
    const t = parseTransaction(f.send.mock.calls[0]![0]);
    expect(t).toMatchObject({
      chainId: CHAIN,
      nonce: 0,
      gas: 21000n,
      value: q.returnValueWei,
    });
    expect(t.to?.toLowerCase()).toBe(OPERATOR.toLowerCase());
    expect(t.data ?? "0x").toBe("0x");
    expect(f.session.frozen).toBe(true);
    expect(() => f.permit.assertSign()).toThrow();
    expect(f.cancel.record?.outcome).toBe("accepted");
    await expect(
      f.cancel.execute(cancellationId(q), String(q.maximumCostWei)),
    ).rejects.toThrow();
    expect(f.signer).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("double action claims before await; timeout is uncertain and never retried", async () => {
    const f = fixture(),
      q = await f.cancel.quote(hash);
    f.change("timeout");
    const results = await Promise.allSettled([
      f.cancel.execute(cancellationId(q), String(q.maximumCostWei)),
      f.cancel.execute(cancellationId(q), String(q.maximumCostWei)),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(f.cancel.record?.outcome).toBe("uncertain");
    expect(f.signer).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  for (const field of [
    "chain",
    "nonce",
    "pending",
    "code",
    "balance",
    "reverted",
    "reorg",
  ]) {
    it(`blocks ${field} change, without signature or send`, async () => {
      const f = fixture();
      f.change(field);
      await expect(f.cancel.quote(hash)).rejects.toThrow();
      expect(f.signer).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    });
  }
  it("revalidates fees after approval; no signing with increased caps", async () => {
    const f = fixture(),
      q = await f.cancel.quote(hash);
    f.change("fees");
    await expect(
      f.cancel.execute(cancellationId(q), String(q.maximumCostWei)),
    ).rejects.toThrow();
    expect(f.signer).not.toHaveBeenCalled();
  });
  it("signature in flight OR attempted without a resulting hash prevents cancellation", async () => {
    const f = fixture(),
      ledger = new FundingLedger(f.review.fundingWei);
    f.permit.approve(reviewId(f.review), String(f.review.fundingWei));
    f.permit.claimFunding(
      CHAIN,
      OPERATOR,
      account.address,
      f.review.fundingWei,
    );
    f.session.financial.push({
      id: "test",
      role: "funding",
      to: account.address,
      value: f.review.fundingWei,
      state: "hash-received",
      hash,
    });
    ledger.observe({
      hash,
      from: OPERATOR,
      to: account.address,
      value: f.review.fundingWei,
      block: "0x10",
      blockHash,
      operatorGas: 1n,
    });
    f.permit.confirmObservedFunding(f.session, ledger);
    f.permit.beginSign();
    await expect(f.cancel.quote(hash)).rejects.toThrow();
    f.permit.endSign();
    await expect(f.cancel.quote(hash)).rejects.toThrow();
    expect(f.signer).not.toHaveBeenCalled();
  });
  it("funding excess remains unapproved until exact recognition; budget and original attempt remain unchanged", async () => {
    const f = fixture(),
      ledger = new FundingLedger(f.review.fundingWei);
    f.permit.approve(reviewId(f.review), String(f.review.fundingWei));
    f.permit.claimFunding(
      CHAIN,
      OPERATOR,
      account.address,
      f.review.fundingWei,
    );
    f.session.financial.push({
      id: "test",
      role: "funding",
      to: account.address,
      value: f.review.fundingWei,
      state: "hash-received",
      hash,
    });
    ledger.observe(await observeFunding(f.read, hash, account.address));
    expect(() => f.permit.confirmObservedFunding(f.session, ledger)).toThrow();
    ledger.recognize(hash, String(ledger.observation!.value));
    f.permit.confirmObservedFunding(f.session, ledger);
    expect(f.session.financial[0]!.value).toBe(f.review.fundingWei);
    expect(f.session.financial[0]!.state).toBe("hash-received");
    f.session.freeze();
    expect(() => f.permit.confirmObservedFunding(f.session, ledger)).toThrow();
  });
  for (const role of ["media", "seal", "release", "sweep"] as const) {
    it(`ANY existing ${role} signature blocks cancellation, not just media`, async () => {
      const f = fixture();
      f.session.signatures.push({
        role,
        hash,
        nonce: 0n,
        index: 0,
        window: 0,
        gas: 21000n,
        maxFee: 1n,
        tip: 1n,
        signedAt: 0,
        outcome: "uncertain",
      });
      await expect(f.cancel.quote(hash)).rejects.toThrow();
    });
  }
  it("rejects changed funding identity and insufficient funding recognition", async () => {
    const f = fixture();
    f.tx.from = account.address;
    await expect(
      observeFunding(f.read, hash, account.address),
    ).rejects.toThrow();
    const ledger = new FundingLedger(4n);
    ledger.observe({
      hash,
      from: OPERATOR,
      to: account.address,
      value: 3n,
      block: "0x10",
      blockHash,
      operatorGas: 1n,
    });
    expect(() => ledger.recognize(hash, "3")).toThrow();
    expect(ledger.ready).toBe(false);
  });
  it("missing receipt remains unknown; cannot infer refund from a balance", async () => {
    const f = fixture(),
      q = await f.cancel.quote(hash);
    await f.cancel.execute(cancellationId(q), String(q.maximumCostWei));
    vi.mocked(f.read.receipt).mockResolvedValue(null);
    expect(await f.cancel.reconcile()).toEqual({
      status: "pending-or-unknown",
    });
    expect(f.cancel.record?.outcome).toBe("accepted");
  });
  it("confirms exact cancellation receipt and accounts returned/gas/residual (RPC double, not EVM)", async () => {
    const f = fixture(),
      q = await f.cancel.quote(hash);
    await f.cancel.execute(cancellationId(q), String(q.maximumCostWei));
    const h = f.cancel.record!.hash;
    vi.mocked(f.read.transaction).mockResolvedValue({
      hash: h,
      from: account.address,
      to: OPERATOR,
      nonce: "0x0",
      value: hex(q.returnValueWei),
      input: "0x",
    } as Awaited<ReturnType<ClassicRpc["transaction"]>>);
    vi.mocked(f.read.receipt).mockResolvedValue({
      transactionHash: h,
      status: "0x1",
      blockNumber: "0x10",
      blockHash,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
    });
    vi.mocked(f.read.balance).mockResolvedValue(q.maximumCostWei - 21000n);
    const result = await f.cancel.reconcile();
    expect(result.status).toBe("included-not-finalized");
    if (result.status === "included-not-finalized") {
      expect(result.returnedWei + result.gasWei! + result.residualWei).toBe(
        q.balance,
      );
    }
    expect(f.signer).toHaveBeenCalledTimes(1);
  });
  it("expired quote and changed recipient are rejected, no signature", async () => {
    const f = fixture(),
      q = await f.cancel.quote(hash);
    expect(Object.isFrozen(q)).toBe(true);
    const now = vi.spyOn(Date, "now").mockReturnValue(q.quotedAt + 300_001);
    try {
      await expect(
        f.cancel.execute(cancellationId(q), String(q.maximumCostWei)),
      ).rejects.toThrow();
    } finally {
      now.mockRestore();
    }
    expect(f.signer).not.toHaveBeenCalled();
    f.tx.to = OPERATOR;
    await expect(f.cancel.quote(hash)).rejects.toThrow();
  });
  it("registers cancellation before CLI approval/funding and never unfreezes; production proxy untouched", () => {
    const source = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    expect(source.indexOf("new PreMediaCancellation")).toBeLessThan(
      source.indexOf('phase = "awaiting-approval"'),
    );
    expect(source).not.toMatch(/frozen\s*=\s*false/);
    expect(HOODI_READ_METHODS.has("eth_sendRawTransaction")).toBe(false);
  });
});

/** Offline doubles + deterministic fixture signatures ONLY. Never public requests. */
import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, type Hex } from "viem";
import { readFileSync } from "node:fs";
import type { ClassicRpc } from "../../lib/classic-session";
import {
  CHAIN,
  OPERATOR,
  Permit,
  planFor,
  retainedSession,
  reviewId,
  mediaTx,
  closeByHash,
  verifySeal,
  type Review,
} from "./core";
import { LabRpc } from "./rpc";
import { validateTransaction } from "../hash-receiver/receiver";
const account = privateKeyToAccount(`0x${"22".repeat(32)}`); // synthetic, never passed to public runner
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
function transaction(raw: Hex) {
  const t = parseTransaction(raw);
  return {
    hash: keccak256(raw),
    from: account.address,
    to: t.to,
    type: "0x2",
    chainId: hex(CHAIN),
    nonce: hex(t.nonce ?? 0),
    value: hex(t.value ?? 0n),
    gas: hex(t.gas!),
    maxFeePerGas: hex(t.maxFeePerGas!),
    maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas!),
    input: t.data ?? "0x",
    accessList: [],
    r: t.r,
    s: t.s,
    yParity: hex(t.yParity ?? 0),
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
  };
}
function fixture() {
  const fees = planFor(1000000n, 100000000n);
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
    blockHash: `0x${"aa".repeat(32)}`,
  };
  const permit = new Permit(review),
    transactions = new Map<Hex, ReturnType<typeof transaction>>();
  const read = {
    latestTransactionCount: vi.fn(async () => await Promise.resolve(0n)),
    transaction: vi.fn(
      async (h: Hex) => await Promise.resolve(transactions.get(h) ?? null),
    ),
    receipt: vi.fn(async () => await Promise.resolve(null)),
  } as unknown as ClassicRpc;
  const send = {
    ...read,
    sendRawTransaction: vi.fn(async (raw: Hex) => {
      await permit.claimSend(raw, session);
      transactions.set(keccak256(raw), transaction(raw));
      return keccak256(raw);
    }),
  };
  const session = retainedSession(account, review, fees, read, send, permit);
  const approve = () => {
    permit.approve(reviewId(review), String(review.fundingWei));
    permit.claimFunding(CHAIN, OPERATOR, account.address, review.fundingWei);
    // Controlled canonical funding evidence, not an actual public transfer.
    session.financial.push({
      id: "fixture",
      role: "funding",
      to: account.address,
      value: review.fundingWei,
      state: "confirmed",
      hash: `0x${"ff".repeat(32)}`,
    });
    permit.confirmFunding(session);
  };
  return { session, review, permit, approve, transactions, send, read };
}
describe("B3 isolated authorization and hash closure", () => {
  it("constructing/quoting causes no signature or send; signing cannot precede approval", async () => {
    const f = fixture();
    expect(f.session.signatures).toHaveLength(0);
    await expect(f.session.sign("media", mediaTx(f.review, 0))).rejects.toThrow(
      "No signing",
    );
    expect(f.send.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("exact amount, chain, operator, session and single funding attempt required", () => {
    const f = fixture();
    expect(() =>
      f.permit.claimFunding(
        CHAIN,
        OPERATOR,
        account.address,
        f.review.fundingWei,
      ),
    ).toThrow();
    expect(() =>
      f.permit.approve(reviewId(f.review), String(f.review.fundingWei + 1n)),
    ).toThrow();
    f.permit.approve(reviewId(f.review), String(f.review.fundingWei));
    for (const args of [
      [1, OPERATOR, account.address, f.review.fundingWei],
      [CHAIN, account.address, account.address, f.review.fundingWei],
      [CHAIN, OPERATOR, OPERATOR, f.review.fundingWei],
      [CHAIN, OPERATOR, account.address, f.review.fundingWei + 1n],
    ] as const)
      expect(() =>
        f.permit.claimFunding(args[0], args[1], args[2], args[3]),
      ).toThrow();
    f.permit.claimFunding(
      CHAIN,
      OPERATOR,
      account.address,
      f.review.fundingWei,
    );
    expect(() =>
      f.permit.claimFunding(
        CHAIN,
        OPERATOR,
        account.address,
        f.review.fundingWei,
      ),
    ).toThrow();
  });
  it("stale authorization cannot start funding", () => {
    const f = fixture();
    expect(() =>
      f.permit.approve(
        reviewId(f.review),
        String(f.review.fundingWei),
        Date.now() + 31 * 60000,
      ),
    ).toThrow();
  });
  it("funding attempt alone never authorizes media signatures", async () => {
    const f = fixture();
    f.permit.approve(reviewId(f.review), String(f.review.fundingWei));
    f.permit.claimFunding(
      CHAIN,
      OPERATOR,
      account.address,
      f.review.fundingWei,
    );
    expect(() => f.permit.confirmFunding(f.session)).toThrow("not confirmed");
    await expect(f.session.sign("media", mediaTx(f.review, 0))).rejects.toThrow(
      "confirmed funding",
    );
    expect(f.send.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("wrong chain, account, value and data never reach network", async () => {
    for (const change of [
      { chainId: 1 },
      { to: OPERATOR },
      { value: 1n },
      { gas: 1n },
    ]) {
      const f = fixture();
      f.approve();
      await expect(
        f.session.sign("media", { ...mediaTx(f.review, 0), ...change }),
      ).rejects.toThrow();
      expect(f.send.sendRawTransaction).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.approve();
    const raw = await f.session.sign("media", {
      ...mediaTx(f.review, 0),
      data: "0x1234",
    });
    await expect(f.session.send(raw)).rejects.toThrow("envelope");
    expect(f.transactions.size).toBe(0);
  });
  it("records signature before send; uncertain outcome never retries and retains account", async () => {
    const f = fixture();
    f.approve();
    const raw = await f.session.sign("media", mediaTx(f.review, 0));
    expect(f.session.signatures[0]?.hash).toBe(keccak256(raw));
    f.send.sendRawTransaction.mockImplementationOnce(async (raw) => {
      await f.permit.claimSend(raw, f.session);
      throw new Error("timeout");
    });
    await expect(f.session.send(raw)).rejects.toThrow("timeout");
    await expect(f.session.send(raw)).rejects.toThrow("already attempted");
    expect(f.send.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.input.account.address).toBe(account.address);
    expect(f.session.signatures[0]?.outcome).toBe("uncertain");
    expect(f.session.frozen).toBe(true);
  });
  it("five same-nonce packets roundtrip through R1 validation without supplying source bytes to reader", async () => {
    const f = fixture();
    f.approve();
    for (let i = 0; i < 5; i++) {
      const raw = await f.session.sign("media", mediaTx(f.review, i), i);
      const hash = await f.session.send(raw);
      const hint = {
        version: 1 as const,
        chainId: CHAIN,
        sessionAddress: account.address,
        streamId: f.review.streamId,
        sequence: i,
        transactionHash: hash,
      };
      const result = await validateTransaction(f.transactions.get(hash), hint, {
        ...hint,
        nonce: 1,
        capacity: 5,
      });
      expect(result.digest).toBe(keccak256(mediaTx(f.review, i).data));
      expect(f.session.signatures[i]?.nonce).toBe(1n);
    }
    f.session.freeze();
    await expect(
      f.session.sign("media", mediaTx(f.review, 0), 5),
    ).rejects.toThrow();
  });
  it("missing or forged seal never permits release", async () => {
    for (const observation of [null, { hash: `0x${"cc".repeat(32)}` }]) {
      const f = fixture();
      f.approve();
      await expect(
        closeByHash(f.session, async () => await Promise.resolve(observation)),
      ).rejects.toThrow();
      expect(f.session.signatures.map((s) => s.role)).toEqual(["seal"]);
      expect(f.session.held).toBe(true);
    }
  });
  it("exact reconstructed seal by lookup permits one release, not proof of exclusion", async () => {
    const f = fixture();
    f.approve();
    await closeByHash(
      f.session,
      async (h) => await Promise.resolve(f.transactions.get(h)),
    );
    expect(f.session.signatures.map((s) => s.role)).toEqual([
      "seal",
      "release",
    ]);
    await expect(
      closeByHash(f.session, async () => await Promise.resolve(null)),
    ).rejects.toThrow("already requested");
    expect(f.send.sendRawTransaction).toHaveBeenCalledTimes(2);
    const seal = f.session.signatures[0]!;
    const wrong = {
      ...f.transactions.get(seal.hash),
      r: `0x${"33".repeat(32)}`,
    };
    await expect(verifySeal(wrong, f.session, seal.hash)).rejects.toThrow();
  });
  it("read transport cannot call send or txpool; 429 does not retry or fall back", async () => {
    const fetcher = vi.fn(
      async () =>
        await Promise.resolve(
          new Response("private provider error", { status: 429 }),
        ),
    );
    const rpc = new LabRpc(
      "chainstack",
      2,
      fetcher,
      {
        PATIO_HOODI_CHAINSTACK_RPC_URL:
          "https://ethereum-hoodi.core.chainstack.com/test",
      },
      true,
    );
    expect(() => rpc.request("eth_sendRawTransaction", [])).toThrow();
    expect(() => rpc.request("txpool_contentFrom", [])).toThrow();
    await expect(rpc.sendRegistered("0x", async () => {})).rejects.toThrow(
      "Reader cannot send",
    );
    await expect(
      rpc.request("eth_getTransactionByHash", ["0x"]),
    ).rejects.toThrow("429");
    await expect(
      rpc.request("eth_getTransactionByHash", ["0x"]),
    ).rejects.toThrow("budget-or-rate-limit");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("unknown URL rejected and errors do not contain protected URLs", async () => {
    expect(
      () =>
        new LabRpc("alchemy", 1, fetch, {
          PATIO_HOODI_ALCHEMY_RPC_URL: "https://example.test/secret",
        }),
    ).toThrow("identity");
    const rpc = new LabRpc(
      "alchemy",
      1,
      vi.fn(() => Promise.reject(new Error("https://secret.invalid/token"))),
      {
        PATIO_HOODI_ALCHEMY_RPC_URL: "https://eth-hoodi.g.alchemy.com/v2/test",
      },
    );
    await expect(rpc.request("eth_chainId")).rejects.toThrow(
      "alchemy: network-timeout-or-invalid-json",
    );
  });
  it("lab reader has no source payload, signing, cache, pool or send call", () => {
    const source = readFileSync(
      new URL("./reader.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /sendRawTransaction|txpool_|generatePrivateKey|signTransaction|packet\(/,
    );
    expect(source).toContain('"eth_getTransactionByHash"');
  });
});

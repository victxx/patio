import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { keccak256, parseTransaction, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ClassicSession,
  classicReceiptFee,
  type ClassicRpc,
} from "./classic-session";
import {
  createPatioReturnPlan,
  snapshotReturnRecipient,
} from "./atomic-public-setup";
import type {
  BrowserEthereumRpc,
  RpcReceipt,
  RpcTransaction,
} from "./direct-hoodi";
import { createFeePlan, MEDIA_TRANSACTION_GAS } from "@patio/ethereum";
import {
  classicExposurePlan,
  createRequiredDirectPlan,
  directFundingRequirementForSweepGas,
} from "./direct-plan";
import { observeClassicMedia } from "./classic-media-observation";

// Deterministic fixture key, no user account. RPC/receipts below are controlled
// doubles, NOT EVM execution or public admission evidence.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const operator = "0x2222222222222222222222222222222222222222" as Address;
const blockHash: Hex = `0x${"aa".repeat(32)}`;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
function fixture(windows = 2) {
  const plan = classicExposurePlan(
    createFeePlan({
      baseFeePerGasWei: 1_040_000n,
      priorityFeePerGasWei: 75_000_000n,
      replacementsPerWindow: 5,
      requestedWindows: windows,
    }),
  );
  const returnPlan = createPatioReturnPlan({
    recipient: operator,
    recipientSnapshot: snapshotReturnRecipient("0x"),
    feePlan: plan,
  });
  const state = {
    nonce: 0n,
    balance: returnPlan.requiredFundingWei,
    code: "0x" as Hex,
    blockHash,
    baseFee: 1_040_000n,
  };
  const receipts = new Map<Hex, RpcReceipt>(),
    transactions = new Map<Hex, RpcTransaction>();
  const rpc: ClassicRpc = {
    chainId: vi.fn(async () => await Promise.resolve(1337)),
    request: vi.fn(async (method: string) => {
      await Promise.resolve();
      if (method === "eth_getBlockByNumber")
        return {
          number: "0x10",
          hash: state.blockHash,
          baseFeePerGas: `0x${state.baseFee.toString(16)}`,
        };
      if (method === "eth_getTransactionCount")
        return `0x${state.nonce.toString(16)}`;
      if (method === "eth_getBalance") return `0x${state.balance.toString(16)}`;
      if (method === "eth_getCode") return state.code;
      throw new Error("Unexpected fixture read");
    }) as ClassicRpc["request"],
    receipt: vi.fn(
      async (hash: Hex) => await Promise.resolve(receipts.get(hash) ?? null),
    ),
    transaction: vi.fn(
      async (hash: Hex) =>
        await Promise.resolve(transactions.get(hash) ?? null),
    ),
    latestTransactionCount: vi.fn(
      async () => await Promise.resolve(state.nonce),
    ),
    balance: vi.fn(async () => await Promise.resolve(state.balance)),
    code: vi.fn(async () => await Promise.resolve(state.code)),
    estimateGas: vi.fn(async () => await Promise.resolve(21_000n)),
    sendRawTransaction: vi.fn(async (raw: Hex) => {
      await Promise.resolve();
      const tx = parseTransaction(raw),
        hash = keccak256(raw);
      transactions.set(hash, {
        hash,
        from: account.address,
        to: tx.to ?? null,
        nonce: `0x${(tx.nonce ?? 0).toString(16)}`,
        value: `0x${(tx.value ?? 0n).toString(16)}`,
      });
      return hash;
    }),
  };
  const session = new ClassicSession({
    attemptId: "fixture",
    account,
    operator,
    chainId: 1337,
    g: 0n,
    plan,
    replacements: 5,
    returnPlan,
    fromBlock: 1n,
    clients: { read: rpc, send: rpc, observer: rpc as BrowserEthereumRpc },
  });
  const tx = (role: "media" | "seal" | "release", index = 0) => ({
    type: "eip1559" as const,
    chainId: 1337,
    to: account.address,
    value: 0n,
    data: role === "media" ? ("0xab" as Hex) : ("0x" as Hex),
    nonce:
      role === "release"
        ? 0
        : role === "seal"
          ? 1 + index
          : 1 + Math.floor(index / 5),
    gas: role === "media" ? MEDIA_TRANSACTION_GAS : 21_000n,
    maxFeePerGas:
      role === "media"
        ? plan.mediaFeeLadderWei[index % 5]!
        : plan.sealMaxFeePerGasWei,
    maxPriorityFeePerGas:
      role === "media"
        ? plan.mediaPriorityFeeLadderWei[index % 5]!
        : plan.sealPriorityFeePerGasWei,
  });
  const include = (hash: Hex, status: Hex = "0x1") => {
    receipts.set(hash, {
      transactionHash: hash,
      blockNumber: "0x10",
      blockHash,
      status,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
    });
  };
  const close = async (mediaWins = false) => {
    const release = await session.sign("release", tx("release"));
    await session.send(release);
    include(keccak256(release));
    for (let i = 0; i < windows; i++) {
      const role = mediaWins ? "media" : "seal";
      if (mediaWins && i > 0)
        for (let j = (i - 1) * 5 + 1; j < i * 5; j++)
          await session.sign("media", tx("media", j), j);
      const raw = await session.sign(
        role,
        tx(role, mediaWins ? i * 5 : i),
        mediaWins ? i * 5 : i,
      );
      await session.send(raw);
      include(keccak256(raw), mediaWins ? "0x0" : "0x1");
    }
    state.nonce = session.sweepNonce;
    session.beginCleanup();
  };
  return {
    session,
    plan,
    returnPlan,
    rpc,
    state,
    receipts,
    transactions,
    tx,
    include,
    close,
  };
}

describe("Cast pre-media cancellation, real fixture signatures / mocked canonical reads", () => {
  function funded(count = 2) {
    const f = fixture(1);
    const value = f.state.balance;
    const hashes = Array.from({ length: count }, (_, i) => h(100 + i));
    for (const hash of hashes) {
      f.transactions.set(hash, {
        hash,
        from: operator,
        to: account.address,
        nonce: "0x2f",
        type: "0x0",
        value: `0x${value.toString(16)}`,
        input: "0x",
      });
      f.include(hash);
    }
    f.state.balance = value * BigInt(count);
    return { ...f, hashes };
  }
  it("accepts legacy receipts, deduplicates two deposits without expanding plan, returns once despite prepared empty signatures", async () => {
    const f = funded();
    const original = f.session.input.plan.maximumExposureWei;
    const seal = await f.session.sign("seal", f.tx("seal"));
    await f.session.sign("release", f.tx("release"));
    const review = await f.session.reviewCancellation([
      ...f.hashes,
      f.hashes[0]!,
    ]);
    expect(f.session.fundings.size).toBe(2);
    expect(f.session.input.plan.maximumExposureWei).toBe(original);
    expect(review.value).toBe(f.state.balance - review.maximumGasCost);
    const result = f.session.cancelBeforeMedia(review);
    expect(() => f.session.claimCapture()).toThrow();
    expect(() => f.session.beginCleanup()).toThrow();
    await expect(f.session.cancelBeforeMedia(review)).rejects.toThrow();
    await expect(f.session.send(seal)).rejects.toThrow();
    const hash = await result;
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.signatures.find((s) => s.hash === hash)?.role).toBe(
      "cancel",
    );
    f.include(hash);
    f.state.nonce = 1n;
    f.state.balance = 123n;
    expect(await f.session.confirmCancellation()).toBe(true);
    expect(f.session.residual).toBe(123n);
  });
  it("accepts one funding but rejects unknown extra balance, media signatures and uncertain sends", async () => {
    const f = funded(1);
    expect((await f.session.reviewCancellation(f.hashes)).balance).toBe(
      f.state.balance,
    );
    f.state.balance++;
    await expect(f.session.reviewCancellation(f.hashes)).rejects.toThrow();
    f.state.balance--;
    await f.session.sign("media", f.tx("media"));
    await expect(f.session.reviewCancellation(f.hashes)).rejects.toThrow();
    const g = funded(1);
    const seal = await g.session.sign("seal", g.tx("seal"));
    vi.mocked(g.rpc.sendRawTransaction).mockRejectedValueOnce(Error("timeout"));
    await expect(g.session.send(seal)).rejects.toThrow();
    await expect(g.session.reviewCancellation(g.hashes)).rejects.toThrow();
  });
  it("Start wins exclusively and late cancellation cannot sign", async () => {
    const f = funded(1);
    const review = await f.session.reviewCancellation(f.hashes);
    f.session.claimCapture();
    await expect(f.session.cancelBeforeMedia(review)).rejects.toThrow();
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("B2 classic cumulative exposure regression", () => {
  it("covers a media winner at every authorized nonce, release and sweep", () => {
    const plan = createFeePlan({
      baseFeePerGasWei: 1_040_000n,
      priorityFeePerGasWei: 75_000_000n,
      replacementsPerWindow: 5,
      requestedWindows: 4,
    });
    const required =
      BigInt(plan.windows) *
        MEDIA_TRANSACTION_GAS *
        plan.mediaFeeLadderWei.at(-1)! +
      42_000n * plan.sealMaxFeePerGasWei;
    expect(
      directFundingRequirementForSweepGas(classicExposurePlan(plan))
        .maximumExposureWei,
    ).toBe(required);
  });
  it("does not add all replacements as simultaneous winners", () => {
    const { plan } = fixture(4);
    expect(plan.maximumExposureWei).toBe(
      4n * MEDIA_TRANSACTION_GAS * plan.mediaFeeLadderWei.at(-1)! +
        42_000n * plan.sealMaxFeePerGasWei,
    );
    expect(plan.maximumExposureWei).toBeLessThan(
      4n *
        MEDIA_TRANSACTION_GAS *
        plan.mediaFeeLadderWei.reduce((a, b) => a + b, 0n),
    );
  });
  it("rejects the same duration after cumulative exposure exceeds the selected budget", () => {
    expect(
      createRequiredDirectPlan(
        1_040_000n,
        75_000_000n,
        90,
        1_000_000_000_000_000n,
      ),
    ).not.toBeNull();
    expect(
      createRequiredDirectPlan(
        1_040_000n,
        75_000_000n,
        90,
        1_000_000_000_000_000n,
        3000,
        undefined,
        "classic-per-nonce-v2",
      ),
    ).toBeNull();
  });
});

describe("new classic in-memory financial coordinator (RPC doubles)", () => {
  it("keeps the wallet-disconnect effect behind a custody guard (static integration regression)", () => {
    const source = readFileSync(
      new URL("../components/direct-cast-console.tsx", import.meta.url),
      "utf8",
    );
    const effect = source.slice(
      source.indexOf("if (wallet) {"),
      source.indexOf("const connectWallet ="),
    );
    const guard = effect.indexOf(
      "if (sessionRef.current || pendingAtomicSessionRef.current)",
    );
    const clear = effect.indexOf("sessionRef.current = null");
    expect(guard).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(guard);
    expect(effect.slice(guard, clear)).toMatch(
      /return;\s*}\s*stopRecorder\(\);\s*$/,
    );
  });
  it("retains a hash when the next read fails, without second funding", async () => {
    const { session, rpc, returnPlan } = fixture();
    const send = vi.fn(async () => await Promise.resolve(h(1)));
    await session.financialRequest(
      "funding",
      account.address,
      returnPlan.requiredFundingWei,
      async () => {
        await Promise.resolve();
      },
      send,
    );
    vi.mocked(rpc.receipt).mockRejectedValueOnce(new Error("read unavailable"));
    await expect(session.confirmFinancial("funding")).rejects.toThrow(
      "unavailable",
    );
    expect(session.financial[0]).toMatchObject({
      hash: h(1),
      state: "uncertain",
    });
    await expect(
      session.financialRequest(
        "funding",
        account.address,
        1n,
        async () => {
          await Promise.resolve();
        },
        send,
      ),
    ).rejects.toThrow("already retained");
    expect(send).toHaveBeenCalledTimes(1);
    expect(session.input.account).toBe(account);
  });
  it("retains unknown no-hash wallet result and does not infer it from balance", async () => {
    const { session } = fixture();
    await expect(
      session.financialRequest(
        "funding",
        account.address,
        1n,
        async () => {
          await Promise.resolve();
        },
        async () => {
          await Promise.resolve();
          throw new Error("popup disconnected");
        },
      ),
    ).rejects.toThrow();
    expect(session.financial[0]).toMatchObject({ state: "uncertain" });
    expect(session.financial[0]?.hash).toBeUndefined();
    await expect(session.confirmFinancial("funding")).rejects.toThrow(
      "no exact hash",
    );
  });
  it("claims the attempt synchronously while readiness is pending", async () => {
    const { session } = fixture();
    let resolve!: () => void;
    const readiness = new Promise<void>((r) => {
      resolve = r;
    });
    const send = vi.fn(async () => await Promise.resolve(h(2)));
    const first = session.financialRequest(
      "funding",
      account.address,
      1n,
      () => readiness,
      send,
    );
    await expect(
      session.financialRequest(
        "funding",
        account.address,
        1n,
        async () => {
          await Promise.resolve();
        },
        send,
      ),
    ).rejects.toThrow();
    resolve();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["microphone ended", "chain mismatch", "observer missing"])(
    "revalidates %s before wallet dispatch",
    async (message) => {
      const { session } = fixture();
      const send = vi.fn();
      await expect(
        session.financialRequest(
          "funding",
          account.address,
          1n,
          async () => {
            await Promise.resolve();
            throw new Error(message);
          },
          send,
        ),
      ).rejects.toThrow(message);
      expect(send).not.toHaveBeenCalled();
      expect(session.financial[0]?.state).toBe("rejected");
    },
  );
  it("does not fund after an uncertain registry request", async () => {
    const { session } = fixture();
    const fund = vi.fn();
    await expect(
      session.financialRequest(
        "registry",
        operator,
        0n,
        async () => {
          await Promise.resolve();
        },
        async () => {
          await Promise.resolve();
          throw new Error("timeout");
        },
      ),
    ).rejects.toThrow();
    await expect(
      session.financialRequest(
        "funding",
        account.address,
        1n,
        async () => {
          await Promise.resolve();
        },
        fund,
      ),
    ).rejects.toThrow("Earlier");
    expect(fund).not.toHaveBeenCalled();
  });
  it("accepts exact confirmed funding, not a different destination/value", async () => {
    const { session, transactions, include } = fixture();
    await session.financialRequest(
      "funding",
      account.address,
      99n,
      async () => {
        await Promise.resolve();
      },
      async () => await Promise.resolve(h(3)),
    );
    include(h(3));
    transactions.set(h(3), {
      hash: h(3),
      from: operator,
      to: operator,
      nonce: "0x0",
      value: "0x63",
    });
    await expect(session.confirmFinancial("funding")).rejects.toThrow(
      "reviewed action",
    );
    transactions.get(h(3))!.to = account.address;
    await session.confirmFinancial("funding");
    expect(session.financial[0]?.state).toBe("confirmed");
  });
  it("recovers readiness by reads after confirmed funding followed by a balance-read failure", async () => {
    const { session, rpc, transactions, include } = fixture();
    const wallet = vi.fn(async () => await Promise.resolve(h(3)));
    const revalidate = async () => {
      await Promise.resolve();
    };
    await session.financialRequest(
      "funding",
      account.address,
      99n,
      revalidate,
      wallet,
    );
    include(h(3));
    transactions.set(h(3), {
      hash: h(3),
      from: operator,
      to: account.address,
      nonce: "0x0",
      value: "0x63",
    });
    vi.mocked(rpc.balance).mockRejectedValueOnce(
      new Error("balance read unavailable"),
    );
    await expect(session.reconcileFunding()).rejects.toThrow(
      "balance read unavailable",
    );
    expect(session.financial[0]?.state).toBe("confirmed");
    expect(session.held).toBe(true);
    await expect(
      session.financialRequest(
        "funding",
        account.address,
        99n,
        revalidate,
        wallet,
      ),
    ).rejects.toThrow("already retained");
    await session.reconcileFunding();
    expect(session.held).toBe(false);
    expect(wallet).toHaveBeenCalledTimes(1);
  });
});

describe("classic signature inventory and irreversible stop", () => {
  it("records every signature before uncertain send, with no raw payload in inventory", async () => {
    const { session, rpc, tx } = fixture();
    const raw = await session.sign("media", tx("media"));
    vi.mocked(rpc.sendRawTransaction).mockImplementationOnce(async () => {
      await Promise.resolve();
      expect(session.signatures[0]?.hash).toBe(keccak256(raw));
      throw new Error("timeout");
    });
    await expect(session.send(raw)).rejects.toThrow();
    expect(session.signatures[0]?.outcome).toBe("uncertain");
    expect(session.frozen).toBe(true);
    await expect(session.send(raw)).rejects.toThrow("already attempted");
    expect(Object.keys(session.signatures[0]!)).not.toContain("raw");
    expect(Object.keys(session.signatures[0]!)).not.toContain("data");
  });
  it("pre-signed seal/release do not freeze media; Stop does and cleanup runs once", async () => {
    const { session, tx } = fixture();
    await session.sign("release", tx("release"));
    await session.sign("seal", tx("seal"));
    expect(session.frozen).toBe(false);
    await session.sign("media", tx("media"));
    session.beginCleanup();
    await expect(session.sign("media", tx("media", 1), 1)).rejects.toThrow(
      "frozen",
    );
    expect(() => session.beginCleanup()).toThrow("already");
  });
  it("checks nonce, index, fees, gas and capacity before signing", async () => {
    const { session, tx } = fixture(1);
    await expect(
      session.sign("media", { ...tx("media"), nonce: 2 }),
    ).rejects.toThrow("outside");
    await expect(
      session.sign("media", { ...tx("media"), maxFeePerGas: 1n }),
    ).rejects.toThrow("outside");
    for (let i = 0; i < 5; i++) await session.sign("media", tx("media", i), i);
    await expect(session.sign("media", tx("media", 5), 5)).rejects.toThrow(
      "sequence",
    );
    expect(session.signatures).toHaveLength(5);
  });
  it("keeps all 25 media slots plus prepared cleanup and sweep capacity across failed/missing observer snapshots", async () => {
    const { session, tx, rpc } = fixture(5);
    for (let w = 0; w < 5; w++) await session.sign("seal", tx("seal", w), w);
    await session.sign("release", tx("release"));
    const observer = {
      txpoolContentFrom: vi.fn(async () => {
        await Promise.resolve();
        if (observer.txpoolContentFrom.mock.calls.length % 2)
          throw Error("read unavailable");
        return { pending: {}, queued: {} };
      }),
    };
    for (let i = 0; i < 25; i++) {
      const raw = await session.sign("media", tx("media", i), i);
      const hash = await session.send(raw);
      expect(
        await observeClassicMedia(observer, account.address, hash),
      ).not.toBe("observed");
    }
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(25);
    expect(observer.txpoolContentFrom).toHaveBeenCalledTimes(25);
    expect(session.signatures).toHaveLength(31);
    expect(session.capacity).toBe(32); // one reserved final sweep
    expect(session.frozen).toBe(false);
    expect(new Set(session.signatures.map((s) => s.hash)).size).toBe(31);
  });
  it("identifies a duplicate signing slot rather than falsely reporting inventory exhaustion", async () => {
    const { session, tx } = fixture();
    await session.sign("media", tx("media"));
    await expect(session.sign("media", tx("media"))).rejects.toThrow(
      "Signature already reserved for media:0",
    );
    expect(session.signatures.length).toBeLessThan(session.capacity);
  });
  it("refuses unregistered raw transactions", async () => {
    const { session, rpc } = fixture();
    await expect(session.send("0x1234")).rejects.toThrow("Unregistered");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("canonical winner and one dynamic sweep (controlled canonical doubles)", () => {
  it("allows a new head during return preparation when the snapshot remains canonical and funds are unchanged", async () => {
    const { session, close, rpc } = fixture();
    await close();
    const original = rpc.request;
    let heads = 0;
    rpc.request = vi.fn(async (method: string, params: unknown[] = []) => {
      if (
        method === "eth_getBlockByNumber" &&
        params?.[0] === "latest" &&
        ++heads > 1
      )
        return { number: "0x11", hash: h(17), baseFeePerGas: "0xfde80" };
      return original(method, params);
    }) as ClassicRpc["request"];
    await expect(session.sweep()).resolves.toMatch(/^0x/);
    expect(session.signatures.filter((s) => s.role === "sweep")).toHaveLength(
      1,
    );
  });
  it("reconciles media winners including reverted media without waiting for losing seals", async () => {
    const { session, close } = fixture();
    await close(true);
    await session.reconcile();
    expect(session.mediaIncluded.size).toBe(2);
    expect(session.held).toBe(false);
  });
  it("holds unknown winners rather than inventing seals", async () => {
    const { session, close, receipts } = fixture();
    await close();
    receipts.clear();
    await expect(session.reconcile()).rejects.toThrow("UNKNOWN WINNER");
  });
  it("invalidates a receipt on block hash change", async () => {
    const { session, close, state } = fixture();
    await close();
    state.blockHash = h(8);
    await expect(session.reconcile()).rejects.toThrow("reorg");
  });
  it("signs a single sweep from the reconciled lower balance; uncertainty cannot sign again", async () => {
    const { session, close, state, rpc } = fixture();
    await close();
    state.balance = 200_000_000_000_000n;
    vi.mocked(rpc.sendRawTransaction).mockRejectedValueOnce(
      new Error("sweep timeout"),
    );
    await expect(session.sweep()).rejects.toThrow("timeout");
    const sweep = session.signatures.find((s) => s.role === "sweep")!;
    expect(sweep.outcome).toBe("uncertain");
    expect(session.sweepSnapshot?.balance).toBe(state.balance);
    await expect(session.sweep()).rejects.toThrow("already attempted");
    expect(session.signatures.filter((s) => s.role === "sweep")).toHaveLength(
      1,
    );
  });
  it("does not erase media inclusion after a confirmed sweep; reconciles exact returned value and residual", async () => {
    const { session, close, state, include, transactions } = fixture();
    await close(true);
    state.balance = 200_000_000_000_000n;
    const original = state.balance;
    const hash = await session.sweep();
    expect(hash).not.toBeNull();
    const value = BigInt(transactions.get(hash!)!.value);
    expect(value).toBe(
      original -
        session.input.returnPlan.sweepGasLimit *
          session.input.plan.sealMaxFeePerGasWei,
    );
    include(hash!);
    state.nonce++;
    state.balance = original - value - 21_000n;
    await session.confirmSweep();
    expect(session.returned).toBe(value);
    expect(session.residual).toBe(state.balance);
    expect(session.mediaIncluded.size).toBe(2);
  });
  it("leaves a non-transferable residual without signing a useless sweep", async () => {
    const { session, close, state } = fixture();
    await close();
    state.balance = 1n;
    expect(await session.sweep()).toBeNull();
    expect(session.residual).toBe(1n);
    expect(session.signatures.some((s) => s.role === "sweep")).toBe(false);
  });
  it("invalidates an earlier return confirmation on reorg without losing its hash or media incident", async () => {
    const { session, close, state, include } = fixture();
    await close(true);
    const hash = await session.sweep();
    include(hash!);
    state.nonce++;
    await session.confirmSweep();
    expect(session.returned).not.toBeNull();
    state.blockHash = h(99);
    await expect(session.confirmSweep()).rejects.toThrow("reorg");
    expect(session.held).toBe(true);
    expect(session.returned).toBeNull();
    expect(session.residual).toBeNull();
    expect(session.mediaIncluded.size).toBe(2);
    expect(session.signatures.find((s) => s.role === "sweep")?.hash).toBe(hash);
    await expect(session.sweep()).rejects.toThrow("already attempted");
  });
  it("does not raise fees to overcome the approved cap", async () => {
    const { session, close, state } = fixture();
    await close();
    state.baseFee = session.input.plan.sealMaxFeePerGasWei + 1n;
    await expect(session.sweep()).rejects.toThrow("reviewed nonce/code/fees");
  });
  it("keeps code-bearing return simulation and gas bounds", async () => {
    const { session, close, state, rpc } = fixture();
    session.input.returnPlan.recipientCode = "0x6000";
    state.code = "0x6000";
    await close();
    vi.mocked(rpc.estimateGas).mockResolvedValue(200_000n);
    await expect(session.sweep()).rejects.toThrow("exceeds reviewed gas");
    expect(rpc.estimateGas).toHaveBeenCalledTimes(1);
  });
  it("retains the same RPC instances and does not switch on a lease error", async () => {
    const { session, rpc, tx } = fixture();
    const clients = session.input.clients;
    const raw = await session.sign("media", tx("media"));
    vi.mocked(rpc.sendRawTransaction).mockRejectedValueOnce(
      new Error("lease expired"),
    );
    await expect(session.send(raw)).rejects.toThrow("lease");
    expect(session.input.clients).toBe(clients);
    expect(clients.read).toBe(rpc);
    expect(clients.send).toBe(rpc);
  });
  it("reports missing receipt gas as unknown, never zero", () => {
    expect(
      classicReceiptFee({
        transactionHash: h(1),
        blockNumber: "0x1",
        status: "0x1",
      }),
    ).toBeNull();
  });
});

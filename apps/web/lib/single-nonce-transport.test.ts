import { describe, it, expect, vi } from "vitest";
import {
  keccak256,
  parseTransaction,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { PatioCodec, PatioPacketType, packetFromHex } from "@patio/protocol";
import {
  PrivateRetirementEnvironment,
  readCanonicalRetirement,
  type PrivateRetirementRpc,
} from "./private-retirement-environment";
import { SingleNonceTransport } from "./single-nonce-transport";
import { RetirementInventory } from "./single-nonce-state";
import { quoteSingleNonce, affordableSingleNonce } from "./single-nonce-plan";

const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const operator = "0x1111111111111111111111111111111111111111";
const ids = ["a".repeat(128), "b".repeat(128), "c".repeat(128)] as const;
async function fixture(mode = "success") {
  let missingPeer = false;
  let nonce = mode === "nonzero-gap" ? 7 : 0;
  let closeSigned = false;
  const sends: {
    node: number;
    raw: Hex;
    hash: Hex;
    tx: ReturnType<typeof parseTransaction>;
  }[] = [];
  const receipts = new Map<Hex, Record<string, unknown>>();
  const blockHash = hash(999);
  const nodes = [0, 1, 2].map((i): PrivateRetirementRpc => ({
    async request<T>(
      method: string,
      params: readonly unknown[] = [],
    ): Promise<T> {
      await Promise.resolve();
      let result: unknown;
      if (method === "eth_chainId")
        result = mode === "hoodi" ? "0x88bb0" : "0x539";
      else if (method === "web3_clientVersion")
        result =
          i === 0
            ? "Nethermind/v1.39.3+28cbe2a0"
            : "Geth/v1.17.5-stable-9621c6ad";
      else if (method === "admin_nodeInfo") result = { id: ids[i] };
      else if (method === "admin_peers")
        result = ids
          .filter((_, j) => j !== i && !(missingPeer && i === 0 && j === 1))
          .map((id) => ({ id }));
      else if (method === "eth_syncing") result = false;
      else if (method === "eth_maxPriorityFeePerGas")
        result = toHex(1_000_000_000n);
      else if (method === "eth_getBalance")
        result = toHex(5_000_000_000_000_000n);
      else if (method === "eth_getCode") result = "0x";
      else if (method === "eth_getTransactionCount")
        result = toHex(
          params[1] === "0x3" && closeSigned && nonce >= 2 ? 2 : nonce,
        );
      else if (method === "eth_getBlockByNumber")
        result = {
          hash: params[0] === "0x0" ? hash(1) : blockHash,
          number: nonce === 3 ? "0x4" : "0x3",
          baseFeePerGas: toHex(1_000_000_000n),
          transactions: [...receipts.keys()],
        };
      else if (method === "eth_getTransactionReceipt")
        result = receipts.get(params[0] as Hex) ?? null;
      else if (method === "txpool_content") {
        if (closeSigned && mode === "empty-pool") return {} as T;
        if (closeSigned && ["absent", "pending", "timeout"].includes(mode))
          throw new Error("Injected unavailable observer");
        result = {
          queued: {
            session: Object.fromEntries(
              sends.map((s) => [
                s.hash,
                {
                  hash: s.hash,
                  nonce: toHex(s.tx.nonce!),
                  input: s.tx.data ?? "0x",
                  from:
                    s.tx.type === "eip1559" && s.tx.nonce === 2
                      ? sends.find((x) => x.tx.nonce === 1)?.tx.to
                      : s.tx.to,
                },
              ]),
            ),
          },
        };
      } else if (method === "eth_sendRawTransaction") {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        const txHash = keccak256(raw);
        sends.push({ node: i, raw, hash: txHash, tx });
        result = txHash;
        if (tx.type === "eip7702") {
          closeSigned = true;
          if (mode === "timeout") throw new Error("Timeout after dispatch");
          if (
            !["absent", "pending", "empty-pool", "visible-pending"].includes(
              mode,
            )
          ) {
            nonce = mode === "wrong-transition" ? 1 : 2;
            receipts.set(txHash, {
              transactionHash: txHash,
              blockHash,
              blockNumber: "0x3",
              status: mode === "revert" ? "0x0" : "0x1",
              gasUsed: toHex(36800),
              effectiveGasPrice: toHex(2_000_000_000n),
            });
            if (mode.startsWith("media-included")) {
              const media = sends.find((s) => s.tx.nonce === 1)!;
              receipts.set(media.hash, {
                transactionHash: media.hash,
                blockHash,
                blockNumber: "0x3",
                status: mode.endsWith("revert") ? "0x0" : "0x1",
                gasUsed: toHex(50000),
                effectiveGasPrice: toHex(2_000_000_000n),
              });
            }
          }
        } else if (tx.nonce === 2) {
          if (mode === "sweep-fail") throw new Error("Sweep unavailable");
          nonce = 3;
          receipts.set(txHash, {
            transactionHash: txHash,
            blockHash,
            blockNumber: "0x4",
            status: "0x1",
            gasUsed: toHex(21000),
            effectiveGasPrice: toHex(2_000_000_000n),
          });
        }
      } else throw new Error(`Unexpected read ${method}`);
      return result as T;
    },
  }));
  const env = await PrivateRetirementEnvironment.attest(
    {
      kind: "patio-owned-prague-fixture",
      chainId: 1337,
      genesisHash: hash(1),
      nodeIds: ids,
    },
    nodes as [PrivateRetirementRpc, PrivateRetirementRpc, PrivateRetirementRpc],
  );
  const session = await SingleNonceTransport.prepare(env, {
    operator,
    candidates: 4,
    budget: 5_000_000_000_000_000n,
    onEvent: () => {
      throw new Error("Metrics failed");
    },
  });
  let fundingCalls = 0;
  await session.fund(async () => {
    fundingCalls++;
    await Promise.resolve();
  });
  session.start();
  const media = () =>
    session.sendMedia(
      new Uint8Array([1, 2, 3]),
      PatioPacketType.AUDIO,
      PatioCodec.OPUS_WEBM,
      0n,
    );
  return {
    env,
    session,
    sends,
    receipts,
    media,
    fundingCalls,
    dropPeer: () => {
      missingPeer = true;
    },
  };
}

describe("single-nonce inventory and quote", () => {
  it("supports nonzero g, never resets index, permanently freezes", () => {
    const inventory = new RetirementInventory(7, 4);
    expect([inventory.g, inventory.m, inventory.s]).toEqual([7, 8, 9]);
    for (const [role, nonce] of [
      ["release", 7],
      ["authorization", 7],
      ["seal", 8],
      ["media", 9],
    ] as const)
      expect(() => inventory.assertIntent(role, nonce, 0)).toThrow();
    inventory.transition("broadcasting");
    inventory.record({
      role: "media",
      nonce: 8,
      index: 0,
      hash: hash(1),
      maxFee: "100",
      tip: "10",
    });
    expect(() => inventory.assertIntent("media", 8, 0)).toThrow();
    expect(() =>
      inventory.record({
        role: "media",
        nonce: 8,
        index: 1,
        hash: hash(2),
        maxFee: "99",
        tip: "11",
      }),
    ).toThrow();
    inventory.freeze();
    expect(() => inventory.assertIntent("media", 8, 1)).toThrow();
    expect(() => inventory.transition("broadcasting")).toThrow();
    inventory.safetyFailure();
    expect(() => inventory.transition("complete")).toThrow();
  });
  it("quotes continuous bigint growth and both unchanged ceilings", () => {
    const plans = [1, 4, 10, 20].map((candidates) =>
      quoteSingleNonce({
        baseFee: 1_000_000_000n,
        priorityFee: 1_000_000_000n,
        candidates,
      }),
    );
    expect(plans[0]!.mediaFees[0]).toBe(3_000_000_000n);
    expect(plans.every((p) => !p.allowed)).toBe(true);
    expect(plans[3]!.requiredExposure).toBeGreaterThan(5_000_000_000_000_000n);
    const reduced = affordableSingleNonce({
      baseFee: 1_000_000_000n,
      priorityFee: 1_000_000_000n,
      candidates: 20,
      budget: 5_000_000_000_000_000n,
    });
    expect(reduced.candidates).toBeLessThan(20);
    expect(reduced.requiredExposure).toBeLessThanOrEqual(
      5_000_000_000_000_000n,
    );
    expect(() =>
      affordableSingleNonce({
        baseFee: 1_000_000_000n,
        priorityFee: 1_000_000_000n,
        candidates: 4,
      }),
    ).toThrow();
  });
});

describe("integrated retirement controller (mock RPC, real local signatures)", () => {
  it("four candidates one nonce, complete close then sweep, no exposed key/raw export", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.media();
    expect(f.session.snapshot().state).toBe("media-frozen");
    await expect(f.media()).rejects.toThrow();
    await Promise.all([f.session.stop(), f.session.stop()]);
    expect(f.sends.map((s) => [s.node, s.tx.type, s.tx.nonce])).toEqual([
      [0, "eip1559", 1],
      [0, "eip1559", 1],
      [0, "eip1559", 1],
      [0, "eip1559", 1],
      [1, "eip7702", 0],
      [1, "eip1559", 2],
    ]);
    for (let i = 0; i < 4; i++)
      expect(packetFromHex(f.sends[i]!.tx.data!).sequence).toBe(i);
    const close = f.sends[4]!.tx;
    expect(close.type).toBe("eip7702");
    if (close.type === "eip7702")
      expect(close.authorizationList).toMatchObject([
        { address: zeroAddress, nonce: 1, chainId: 1337 },
      ]);
    expect(f.session.snapshot().state).toBe("complete");
    const exported = JSON.stringify(f.session.snapshot());
    for (const send of f.sends) expect(exported).not.toContain(send.raw);
    expect(exported).not.toMatch(
      /privateKey|authorizationList|calldata|paymaster|seals|release/,
    );
    await expect(f.session.fund(async () => {})).rejects.toThrow(
      "already attempted",
    );
  });
  it.each(["absent", "pending", "timeout", "revert", "wrong-transition"])(
    "%s close cannot sweep or resume media",
    async (mode) => {
      const f = await fixture(mode);
      await f.media();
      await expect(f.session.stop()).rejects.toThrow();
      expect(f.sends.filter((s) => s.tx.type === "eip7702")).toHaveLength(1);
      expect(f.sends.some((s) => s.tx.nonce === 2)).toBe(false);
      await expect(f.media()).rejects.toThrow();
      await expect(f.session.stop()).rejects.toThrow();
      expect(f.sends).toHaveLength(2);
    },
  );
  it.each(["media-included", "media-included-revert"])(
    "%s permanently fails safety",
    async (mode) => {
      const f = await fixture(mode);
      await f.media();
      await expect(f.session.stop()).rejects.toThrow(
        "Canonical media inclusion",
      );
      expect(f.session.snapshot().state).toBe("safety-failed");
      expect(f.sends.some((s) => s.tx.nonce === 2)).toBe(false);
    },
  );
  it("sweep uncertainty preserves retirement, and reconciliation does not send", async () => {
    const f = await fixture("sweep-fail");
    await f.media();
    await expect(f.session.stop()).rejects.toThrow("uncertain");
    expect(f.session.snapshot().state).toBe("sweep-pending");
    const count = f.sends.length;
    await f.session.reconcile();
    expect(f.sends).toHaveLength(count);
    expect(f.session.snapshot().receipts).toHaveLength(1);
  });
  it("pending close cannot end listener; canonical retirement can", async () => {
    const f = await fixture();
    expect(
      (
        await readCanonicalRetirement(
          f.env,
          f.session.descriptor.sessionAddress,
          2,
        )
      ).retired,
    ).toBe(false);
    await f.media();
    await f.session.stop();
    expect(
      (
        await readCanonicalRetirement(
          f.env,
          f.session.descriptor.sessionAddress,
          2,
        )
      ).retired,
    ).toBe(true);
  });
  it("rejects a loopback proxy reporting real Hoodi before preparation/funding", async () => {
    await expect(fixture("hoodi")).rejects.toThrow(
      "identity/capability mismatch",
    );
    await expect(
      SingleNonceTransport.prepare({} as PrivateRetirementEnvironment, {
        operator,
        candidates: 1,
      }),
    ).rejects.toThrow("Uncertified");
  });
  it("stop serializes outstanding media and cannot run cleanup twice", async () => {
    const f = await fixture();
    const first = f.media();
    const second = f.media();
    const stop = f.session.stop();
    await Promise.all([first, second, stop]);
    expect(f.sends.map((s) => s.tx.nonce)).toEqual([1, 1, 0, 2]);
    await expect(f.media()).rejects.toThrow("frozen");
    await f.session.stop();
    expect(f.sends).toHaveLength(4);
  });
  it("a prepared session without media still closes safely; never ordinary release", async () => {
    const f = await fixture();
    await f.session.stop();
    expect(f.sends.map((s) => s.tx.type)).toEqual(["eip7702", "eip1559"]);
    expect(
      f.session.snapshot().signatures.filter((s) => s.role === "media"),
    ).toHaveLength(0);
  });
  it("canonical close evidence can be invalidated without retry or media restart", async () => {
    const f = await fixture();
    await f.media();
    await f.session.stop();
    f.receipts.delete(f.session.snapshot().closeHash!);
    await expect(f.session.reconcile()).rejects.toThrow(
      "not canonically successful",
    );
    expect(f.session.snapshot().state).toBe("held-close-uncertain");
    expect(f.session.snapshot().receipts).toHaveLength(0);
    expect(f.sends).toHaveLength(3);
    await expect(f.media()).rejects.toThrow();
  });
  it("external snapshot mutation cannot change key custody, plan or signing inventory", async () => {
    const f = await fixture();
    await f.media();
    const snapshot = f.session.snapshot();
    snapshot.signatures.length = 0;
    snapshot.g = 8;
    expect(f.session.snapshot().g).toBe(0);
    expect(f.session.snapshot().signatures).toHaveLength(1);
    expect(Object.isFrozen(f.session.plan)).toBe(true);
    expect(Object.isFrozen(f.session.plan.mediaFees)).toBe(true);
    expect("account" in f.session).toBe(false);
  });
  it.each(["empty-pool", "visible-pending"])(
    "%s is bounded uncertainty, not canonical success",
    async (mode) => {
      const f = await fixture(mode);
      await f.media();
      vi.useFakeTimers();
      try {
        const stopped = expect(f.session.stop()).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(21_000);
        await stopped;
        expect(f.session.snapshot().state).toBe("held-close-uncertain");
        expect(f.sends.map((s) => s.tx.nonce)).toEqual([1, 0]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("concurrent funding validation still enters its callback only once", async () => {
    const f = await fixture();
    const fresh = await SingleNonceTransport.prepare(f.env, {
      operator,
      candidates: 4,
      budget: 5_000_000_000_000_000n,
    });
    let calls = 0;
    const funder = async () => {
      calls++;
      await Promise.resolve();
    };
    const results = await Promise.allSettled([
      fresh.fund(funder),
      fresh.fund(funder),
    ]);
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("derives g from the agreed canonical state rather than hardcoding zero", async () => {
    const f = await fixture("nonzero-gap");
    expect(f.session.descriptor.nonceStart).toBe("7");
    const state = f.session.snapshot();
    expect([state.g, state.m, state.s]).toEqual([7, 8, 9]);
    expect(f.sends).toHaveLength(0);
  });
  it("H2.6: a peer lost after preparation blocks funding, not just the UI", async () => {
    const f = await fixture();
    const fresh = await SingleNonceTransport.prepare(f.env, {
      operator,
      candidates: 4,
      budget: 5_000_000_000_000_000n,
    });
    f.dropPeer();
    const fund = vi.fn();
    await expect(fresh.fund(fund)).rejects.toThrow(
      "Private topology identity/capability mismatch",
    );
    expect(fund).not.toHaveBeenCalled();
    expect(fresh.snapshot().signatures).toEqual([]);
  });
  it("H2.6: funded session never signs media after losing the required peer", async () => {
    const f = await fixture();
    f.dropPeer();
    await expect(f.media()).rejects.toThrow(
      "Private topology identity/capability mismatch",
    );
    expect(f.session.snapshot().signatures).toEqual([]);
    expect(f.sends).toEqual([]);
    expect(f.session.snapshot().frozenAtMonotonicMs).not.toBeNull();
    await expect(f.env.revalidate()).rejects.toThrow();
  });
});

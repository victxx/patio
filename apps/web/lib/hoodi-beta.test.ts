import { describe, expect, it, vi, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { packetToHex, PatioCodec, PatioPacketType } from "@patio/protocol";
import { PATIO_DEFAULTS } from "@patio/config";
import { MEDIA_TRANSACTION_GAS } from "@patio/ethereum";
import { HoodiBetaAdapter, classifyBetaRpcError } from "./hoodi-beta-server";
import { createRequiredDirectPlan } from "./direct-plan";
import { BrowserEthereumRpc } from "./direct-hoodi";
import { assertNewDirectBroadcastAllowed } from "./direct-transport-safety";
import { patioNetworkRuntimeConfigs } from "./network-runtime";
import type { HoodiBetaContext } from "./hoodi-beta";
import { POST } from "../app/api/hoodi-beta/route";

// Synthetic signer and RPC doubles only. No public signing/submissions.
const account = privateKeyToAccount(`0x${"44".repeat(32)}`);
const operator: Hex = "0x1111111111111111111111111111111111111111";
const stream: Hex = `0x${"22".repeat(16)}`;
const p = createRequiredDirectPlan(
  1_040_000n,
  75_000_000n,
  15,
  undefined,
  3000,
  undefined,
  "classic-per-nonce-v2",
)!;
const context: HoodiBetaContext = {
  descriptor: {
    version: 1,
    chainId: 560048,
    operator,
    sessionAddress: account.address,
    streamId: stream,
    nonceStart: "0",
  },
  plan: {
    duration: 15,
    base: "1040000",
    tip: "75000000",
    funding: p.requiredFundingWei.toString(),
  },
};
const f = p.feePlan;
const envelope = (streamId = stream) =>
  packetToHex({
    version: 1,
    type: 1,
    codec: 1,
    flags: 0,
    streamId,
    sequence: 0,
    windowIndex: 0,
    capturedAtMs: 0n,
    payload: new Uint8Array(6000).fill(9),
  });
const media = {
  type: "eip1559" as const,
  chainId: 560048,
  to: account.address,
  nonce: 1,
  value: 0n,
  gas: MEDIA_TRANSACTION_GAS,
  maxFeePerGas: f.mediaFeeLadderWei[0]!,
  maxPriorityFeePerGas: f.mediaPriorityFeeLadderWei[0]!,
  data: envelope(),
};
function fixture() {
  const state = {
    balance: 0n,
    nonce: 0n,
    pool: [] as unknown[],
    failSend: false,
    transactions: new Map<Hex, unknown>(),
  };
  const upstream = vi.fn(
    async (method: string, params: unknown[]): Promise<unknown> => {
      await Promise.resolve();
      if (method === "eth_chainId") return "0x88bb0";
      if (method === "eth_getCode") return "0x";
      if (method === "eth_getBalance") return `0x${state.balance.toString(16)}`;
      if (method === "eth_getTransactionCount")
        return `0x${state.nonce.toString(16)}`;
      if (method === "eth_getBlockByNumber")
        return { baseFeePerGas: "0xfde80" };
      if (method === "txpool_contentFrom") return state.pool;
      if (method === "eth_getTransactionReceipt") return null;
      if (method === "eth_getTransactionByHash")
        return state.transactions.get(params[0] as Hex) ?? null;
      if (method === "eth_sendRawTransaction") {
        if (state.failSend) throw Error("simulated timeout");
        return keccak256(params[0] as Hex);
      }
      throw Error("unexpected method");
    },
  );
  return {
    state,
    upstream,
    adapter: new HoodiBetaAdapter(
      upstream as <T>(m: string, p: unknown[]) => Promise<T>,
    ),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe("production Hoodi beta uses the bounded classic path", () => {
  it("keeps useful RPC classifications without reflecting provider data", () => {
    const secret = "https://secret.example/token signed-bytes-abcdef";
    const known = classifyBetaRpcError(
      "eth_sendRawTransaction",
      -32000,
      `already known ${secret}`,
    );
    expect(known.category).toBe("already-known");
    expect(known.message).toBe("Transaction already known.");
    const unknown = classifyBetaRpcError(
      "eth_sendRawTransaction",
      -32000,
      secret,
    );
    expect(JSON.stringify(unknown)).not.toContain(secret);
    expect(unknown.message).not.toContain(secret);
    expect(
      classifyBetaRpcError(
        "eth_sendRawTransaction",
        -32000,
        "replacement transaction underpriced",
      ).category,
    ).toBe("replacement-underpriced");
  });
  it("public discovery reads the existing registry in five-block pages without any session", async () => {
    const upstream = vi.fn(async () => await Promise.resolve([]));
    const adapter = new HoodiBetaAdapter(
      upstream as <T>() => Promise<T>,
      operator,
    );
    const filter = { address: operator, fromBlock: "0x10", toBlock: "0x14" };
    expect(await adapter.request("eth_getLogs", [filter])).toEqual([]);
    for (const invalid of [
      { ...filter, address: account.address },
      { ...filter, toBlock: "0x15" },
      { ...filter, fromBlock: "latest" },
      { ...filter, topics: [] },
    ])
      await expect(adapter.request("eth_getLogs", [invalid])).rejects.toThrow(
        "registry log range",
      );
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("reuses the video cadence, fee plan and VP8/VP9 packet formats with the same bounded sender", async () => {
    const videoPlan = createRequiredDirectPlan(
      1040000n,
      75000000n,
      15,
      undefined,
      PATIO_DEFAULTS.videoTimesliceMs,
      undefined,
      "classic-per-nonce-v2",
    )!;
    const videoContext: HoodiBetaContext = {
      ...context,
      plan: {
        ...context.plan!,
        mediaMode: "video",
        funding: videoPlan.requiredFundingWei.toString(),
      },
    };
    const { adapter, upstream } = fixture();
    await expect(adapter.review(videoContext)).resolves.toHaveProperty(
      "fundingMaxFee",
    );
    for (const codec of [PatioCodec.WEBM_VP8_OPUS, PatioCodec.WEBM_VP9_OPUS]) {
      const data = packetToHex({
        version: 1,
        type: PatioPacketType.VIDEO,
        codec,
        flags: 0,
        streamId: stream,
        sequence: 1,
        windowIndex: 0,
        capturedAtMs: 0n,
        payload: new Uint8Array(6000),
      });
      const raw = await account.signTransaction({
        ...media,
        data,
        maxFeePerGas: videoPlan.feePlan.mediaFeeLadderWei[1]!,
        maxPriorityFeePerGas: videoPlan.feePlan.mediaPriorityFeeLadderWei[1]!,
      });
      await expect(
        adapter.request("eth_sendRawTransaction", [raw], videoContext),
      ).resolves.toBe(keccak256(raw));
      await expect(
        adapter.request("eth_sendRawTransaction", [raw], context),
      ).rejects.toThrow("Media outside");
    }
    expect(
      upstream.mock.calls.filter(([m]) => m === "eth_sendRawTransaction"),
    ).toHaveLength(2);
  });
  it("default is closed and only exact Hoodi beta routing passes", async () => {
    vi.stubEnv("PATIO_HOODI_BETA_ENABLED", "false");
    expect(
      (
        await POST(
          new Request("https://patio.example/api/hoodi-beta", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(403);
    for (const chainId of [1, 100, 10200, 1337])
      expect(() =>
        assertNewDirectBroadcastAllowed({
          chainId,
          hoodiBeta: true,
          senderRpcUrl: "/api/hoodi-beta",
          observerRpcUrl: "/api/hoodi-beta",
        }),
      ).toThrow();
    expect(() =>
      assertNewDirectBroadcastAllowed({
        chainId: 560048,
        hoodiBeta: true,
        senderRpcUrl: "/api/hoodi-beta",
        observerRpcUrl: "/api/hoodi-beta",
      }),
    ).not.toThrow();
    vi.stubEnv("PATIO_HOODI_BETA_ENABLED", "true");
    vi.stubEnv("PATIO_HOODI_QUICKNODE_RPC_URL", "https://secret.invalid/token");
    const configs = patioNetworkRuntimeConfigs();
    expect(configs[0]?.relayRpc).toEqual({ url: "/api/hoodi-beta" });
    expect(JSON.stringify(configs)).not.toContain("secret.invalid");
  });
  it("fresh review and null receipts perform reads only; no wallet or funding", async () => {
    const { adapter, upstream } = fixture();
    expect(await adapter.review(context)).toEqual({
      fundingMaxFee: "77080000",
      fundingTip: "75000000",
    });
    expect(
      await adapter.request("eth_getTransactionReceipt", [
        `0x${"33".repeat(32)}`,
      ]),
    ).toBeNull();
    expect(
      upstream.mock.calls.some(([m]) => m === "eth_sendRawTransaction"),
    ).toBe(false);
    await expect(
      adapter.review({ ...context, plan: { ...context.plan!, funding: "1" } }),
    ).rejects.toThrow("Plan outside");
  });
  it("uses the browser Host through Next's internal URL without permitting cross-origin calls", async () => {
    vi.stubEnv("PATIO_HOODI_BETA_ENABLED", "true");
    vi.stubEnv(
      "PATIO_HOODI_QUICKNODE_RPC_URL",
      "https://fixture.ethereum-hoodi.quiknode.pro/not-a-key",
    );
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ result: "0x88bb0" }));
    try {
      const request = (origin: string) =>
        new Request("http://localhost:3234/api/hoodi-beta", {
          method: "POST",
          headers: {
            host: "127.0.0.1:3234",
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ method: "eth_chainId", params: [] }),
        });
      expect((await POST(request("https://another.example"))).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      expect((await POST(request("http://127.0.0.1:3234"))).status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });
  it("validates real signed fixture identity, packet, destination, gas and plan before one dispatch", async () => {
    const { adapter, upstream } = fixture();
    for (const changes of [
      { chainId: 1 },
      { to: operator },
      { gas: 21000n },
      { nonce: 2 },
      { data: envelope(`0x${"33".repeat(16)}`) },
      { maxFeePerGas: media.maxFeePerGas + 1n },
    ]) {
      const wrong = await account.signTransaction({ ...media, ...changes });
      await expect(
        adapter.request("eth_sendRawTransaction", [wrong], context),
      ).rejects.toThrow();
    }
    expect(
      upstream.mock.calls.some(([m]) => m === "eth_sendRawTransaction"),
    ).toBe(false);
    const raw = await account.signTransaction(media);
    expect(
      await adapter.request("eth_sendRawTransaction", [raw], context),
    ).toBe(keccak256(raw));
    expect(
      upstream.mock.calls.filter(([m]) => m === "eth_sendRawTransaction"),
    ).toHaveLength(1);
  });
  it("does not retry an ambiguous send and cannot invoke arbitrary or global pool methods", async () => {
    const { adapter, upstream, state } = fixture();
    state.failSend = true;
    await expect(
      adapter.request(
        "eth_sendRawTransaction",
        [await account.signTransaction(media)],
        context,
      ),
    ).rejects.toThrow("timeout");
    expect(
      upstream.mock.calls.filter(([m]) => m === "eth_sendRawTransaction"),
    ).toHaveLength(1);
    for (const m of [
      "txpool_content",
      "admin_nodeInfo",
      "engine_newPayloadV3",
      "eth_sign",
    ])
      await expect(adapter.request(m, [], context)).rejects.toThrow();
    await expect(
      adapter.request("txpool_contentFrom", [operator], context),
    ).rejects.toThrow("session scoped");
    expect(
      await adapter.request("txpool_contentFrom", [account.address], context),
    ).toEqual([]);
  });
  it("does not require seals already checked by Cast to reappear in a later server pool view", async () => {
    const { adapter, state, upstream } = fixture();
    const hashes: Hex[] = [];
    for (let n = 1; n <= f.windows; n++) {
      const seal = await account.signTransaction({
        ...media,
        gas: 21000n,
        nonce: n,
        data: "0x",
        maxFeePerGas: f.sealMaxFeePerGasWei,
        maxPriorityFeePerGas: f.sealPriorityFeePerGasWei,
      });
      const hash = keccak256(seal);
      hashes.push(hash);
      state.transactions.set(hash, {
        hash,
        from: account.address,
        to: account.address,
        nonce: `0x${n.toString(16)}`,
        value: "0x0",
        input: "0x",
        gas: "0x5208",
        maxFeePerGas: `0x${f.sealMaxFeePerGasWei.toString(16)}`,
        maxPriorityFeePerGas: `0x${f.sealPriorityFeePerGasWei.toString(16)}`,
      });
    }
    const release = await account.signTransaction({
      ...media,
      gas: 21000n,
      nonce: 0,
      data: "0x",
      maxFeePerGas: f.sealMaxFeePerGasWei,
      maxPriorityFeePerGas: f.sealPriorityFeePerGasWei,
    });
    const review = { ...context, sealHashes: hashes };
    await expect(
      adapter.request("eth_sendRawTransaction", [release], review),
    ).resolves.toBe(keccak256(release));
    expect(
      upstream.mock.calls.filter(([m]) => m === "eth_sendRawTransaction"),
    ).toHaveLength(1);
    expect(
      upstream.mock.calls.some(
        ([m]) => m === "txpool_contentFrom" || m === "eth_getTransactionByHash",
      ),
    ).toBe(false);
    await expect(
      adapter.request("eth_sendRawTransaction", [release], {
        ...review,
        sealHashes: ["invalid" as Hex],
      }),
    ).rejects.toThrow();
    expect(
      upstream.mock.calls.filter(([m]) => m === "eth_sendRawTransaction"),
    ).toHaveLength(1);
  });
  it("bounds release to the reviewed plan and returns actual accumulated balance", async () => {
    const { adapter, state, upstream } = fixture();
    const cleanup = {
      type: "eip1559" as const,
      chainId: 560048,
      to: account.address,
      value: 0n,
      gas: 21000n,
      maxFeePerGas: f.sealMaxFeePerGasWei,
      maxPriorityFeePerGas: f.sealPriorityFeePerGasWei,
      data: "0x" as Hex,
    };
    const release = await account.signTransaction({ ...cleanup, nonce: 0 });
    for (const patch of [
      { gas: 22000n },
      { value: 1n },
      { maxFeePerGas: f.sealMaxFeePerGasWei + 1n },
    ]) {
      const invalid = await account.signTransaction({
        ...cleanup,
        nonce: 0,
        ...patch,
      });
      await expect(
        adapter.request("eth_sendRawTransaction", [invalid], context),
      ).rejects.toThrow();
    }
    expect(
      upstream.mock.calls.some(([m]) => m === "eth_sendRawTransaction"),
    ).toBe(false);
    expect(
      await adapter.request("eth_sendRawTransaction", [release], context),
    ).toBe(keccak256(release));
    state.nonce = 2n;
    state.balance = p.requiredFundingWei * 2n;
    const sweep = await account.signTransaction({
      ...cleanup,
      to: operator,
      nonce: 2,
      value: state.balance - 21000n * f.sealMaxFeePerGasWei,
    });
    expect(
      await adapter.request("eth_sendRawTransaction", [sweep], context),
    ).toBe(keccak256(sweep));
    state.nonce = 0n;
    const cancel = await account.signTransaction({
      ...cleanup,
      to: operator,
      nonce: 0,
      value: state.balance - 21000n * f.sealMaxFeePerGasWei,
    });
    expect(
      await adapter.request("eth_sendRawTransaction", [cancel], context),
    ).toBe(keccak256(cancel));
  });
  it("pinned browser clients carry session context, without credentials or a process lease", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        await Promise.resolve();
        if (typeof init?.body !== "string") throw Error("Expected JSON body");
        const b = JSON.parse(init.body) as { session: unknown };
        expect(b.session).toEqual(context);
        return Response.json({ result: "0x88bb0" });
      },
    );
    const rpc = new BrowserEthereumRpc(
      { url: "/api/hoodi-beta", betaContext: context },
      fetcher,
    );
    expect(await rpc.chainId()).toBe(560048);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertRpcChain,
  BrowserEthereumRpc,
  createLegacyObserverRpc,
  DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS,
  DIRECT_OBSERVER_POLL_INTERVAL_MS,
  DIRECT_VIDEO_PACKET_DWELL_MS,
  directSessionUrl,
  flattenTxpoolTransactions,
  parseDirectSession,
  type DirectSessionDescriptor,
} from "./direct-hoodi";

const descriptor: DirectSessionDescriptor = {
  version: 1,
  chainId: 560_048,
  operator: "0xe8acf143AFbF8B1371A20ea934D334180190Eac1",
  sessionAddress: "0x1111111111111111111111111111111111111111",
  streamId: "0x11111111111111111111111111111111",
  nonceStart: "7",
};

describe("direct Hoodi browser transport", () => {
  it("H2.6 private listener does not instantiate the unconfigured legacy RPC", () => {
    expect(createLegacyObserverRpc({ url: "" }, true)).toBeNull();
    expect(() => createLegacyObserverRpc({ url: "" }, false)).toThrow(
      "Direct network RPC is not configured",
    );
    expect(
      createLegacyObserverRpc({ url: "https://observer.example" }, false),
    ).toBeInstanceOf(BrowserEthereumRpc);
  });
  it("keeps each video replacement visible longer than a listener poll", () => {
    expect(DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS).toBeLessThan(
      DIRECT_OBSERVER_POLL_INTERVAL_MS,
    );
    expect(DIRECT_VIDEO_PACKET_DWELL_MS).toBeGreaterThan(
      DIRECT_OBSERVER_POLL_INTERVAL_MS,
    );
  });

  it("round-trips a listener URL", () => {
    const url = directSessionUrl("https://patiotokyo.vercel.app", descriptor);
    expect(new URL(url).pathname).toBe("/live");
    expect(parseDirectSession(new URL(url).searchParams)).toEqual(descriptor);
  });

  it("rejects incomplete and malformed listener links", () => {
    expect(parseDirectSession("?station=0x1234")).toBeNull();
    expect(
      parseDirectSession(
        "?station=0x1111111111111111111111111111111111111111&stream=0x12&operator=0x1111111111111111111111111111111111111111&nonce=0&chain=560048",
      ),
    ).toBeNull();
  });

  it("retains chain identity and rejects unknown networks", () => {
    const url = new URL(
      directSessionUrl("https://patiotokyo.vercel.app", {
        ...descriptor,
        chainId: 10_200,
      }),
    );
    expect(parseDirectSession(url.searchParams)?.chainId).toBe(10_200);
    url.searchParams.set("chain", "999999");
    expect(parseDirectSession(url.searchParams)).toBeNull();
  });

  it("flattens competing txpool entries", () => {
    const transaction = {
      hash: `0x${"1".repeat(64)}`,
      input: "0x504154494f",
      nonce: "0x1",
      from: descriptor.sessionAddress,
    } as const;
    expect(
      flattenTxpoolTransactions({
        queued: { [descriptor.sessionAddress]: { 1: transaction } },
      }),
    ).toEqual([transaction]);
  });

  it("sends browser-visible authentication without leaking it into the body", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x88bb0" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
    );
    const fetcher = fetchMock as typeof fetch;
    const rpc = new BrowserEthereumRpc(
      {
        url: "https://rpc.example",
        authHeader: "Provider-Key",
        authToken: "hoodi-test-token",
      },
      fetcher,
    );

    await expect(rpc.chainId()).resolves.toBe(560_048);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Provider-Key")).toBe(
      "hoodi-test-token",
    );
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    expect(init.body).not.toContain("hoodi-test-token");
  });

  it("backs off and retries a temporary free-tier rate limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { message: "You reached free plan rate limit" },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x88bb0" }),
          { status: 200 },
        ),
      );
    const rpc = new BrowserEthereumRpc(
      { url: "https://rpc.example" },
      fetchMock as typeof fetch,
      0,
    );

    await expect(rpc.chainId()).resolves.toBe(560_048);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an observer connected to the wrong network", async () => {
    await expect(
      assertRpcChain(
        { chainId: () => Promise.resolve(560_048) },
        10_200,
        "Observer",
      ),
    ).rejects.toThrow(
      "Observer network mismatch: expected chain 10200, received 560048",
    );
  });

  it("never automatically retries a raw send after a rate-limit response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
      }),
    );
    const rpc = new BrowserEthereumRpc(
      { url: "http://fixture.invalid" },
      fetchMock as typeof fetch,
      0,
    );
    await expect(rpc.sendRawTransaction("0x1234")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Chiado", 10_200],
    ["Gnosis", 100],
  ])(
    "signs %s transactions with the selected chain identity",
    async (_, chainId) => {
      const account = privateKeyToAccount(
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      );
      const raw = await account.signTransaction({
        chainId,
        type: "eip1559",
        to: account.address,
        nonce: 1,
        gas: 21_000n,
        value: 0n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        data: "0x504154494f",
      });
      expect(parseTransaction(raw).chainId).toBe(chainId);
      expect(parseTransaction(raw).data).toBe("0x504154494f");
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import { HoodiProviderPool, hoodiProviderUrls } from "./hoodi-provider-pool";
import { BrowserEthereumRpc } from "./direct-hoodi";
const urls = {
  chainstack: "https://ethereum-hoodi.core.chainstack.com/secret",
  alchemy: "https://eth-hoodi.g.alchemy.com/v2/secret",
  drpc: "https://lb.drpc.live/hoodi/secret",
};
const requestUrl = (url: string | URL | Request) =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
const requestBody = (init?: RequestInit) => {
  if (typeof init?.body !== "string") throw new Error("Expected JSON request");
  return init.body;
};
function fixture(bad = "") {
  const calls: { provider: string; method: string }[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const provider = requestUrl(url).includes("chainstack")
        ? "chainstack"
        : requestUrl(url).includes("alchemy")
          ? "alchemy"
          : "drpc";
      const body = JSON.parse(requestBody(init)) as {
        id: number;
        method: string;
      };
      calls.push({ provider, method: body.method });
      const values: Record<string, unknown> = {
        eth_chainId: bad === provider ? "0x1" : "0x88bb0",
        eth_getBlockByNumber: {
          number: "0x1",
          hash: `0x${"1".repeat(64)}`,
          baseFeePerGas: "0x1",
        },
        eth_getBalance: "0x0",
        eth_getTransactionCount: "0x0",
        eth_getCode: "0x",
        eth_maxPriorityFeePerGas: "0x1",
        eth_getTransactionReceipt: null,
        eth_getTransactionByHash: null,
        eth_getLogs: [],
      };
      return await Promise.resolve(
        Response.json({
          id: body.id,
          ...(body.method in values
            ? { result: values[body.method] }
            : { error: { code: -32601, message: "Method not found secret" } }),
        }),
      );
    },
  );
  return { calls, fetcher };
}
describe("external Hoodi provider selection", () => {
  it("prefers Chainstack for verified reads without certifying sending or observer", async () => {
    const f = fixture();
    const p = await new HoodiProviderPool(urls, f.fetcher).selectReadProvider();
    expect(p.provider).toBe("chainstack");
    expect(p.evidence).toMatchObject({
      chainId: 560048,
      reads: "verified",
      observer: "unavailable",
      send: "unverified",
      publicTransport: "blocked",
    });
    expect(
      f.calls.every(
        (c) =>
          c.provider === "chainstack" && c.method !== "eth_sendRawTransaction",
      ),
    ).toBe(true);
    expect(JSON.stringify(p.evidence)).not.toContain("secret");
  });
  it("wrong chain advances priority before the operation only", async () => {
    const f = fixture("chainstack");
    const p = await new HoodiProviderPool(urls, f.fetcher).selectReadProvider();
    expect(p.provider).toBe("alchemy");
    f.fetcher.mockRejectedValue(new Error(urls.alchemy));
    await expect(p.request("eth_chainId", [])).rejects.toThrow(
      "alchemy: unavailable",
    );
    expect(f.calls.some((c) => c.provider === "drpc")).toBe(false);
  });
  it("uses dRPC only after both earlier providers fail and never sends", async () => {
    const f = fixture();
    const delegate = f.fetcher;
    const fetcher: typeof fetch = (url, init) =>
      requestUrl(url).includes("drpc")
        ? delegate(url, init)
        : Promise.reject(new Error("secret"));
    const p = await new HoodiProviderPool(urls, fetcher).selectReadProvider();
    expect(p.provider).toBe("drpc");
    await expect(p.request("eth_sendRawTransaction", ["0x"])).rejects.toThrow(
      "blocked",
    );
  });
  it("rejects unknown hosts and never leaks URL/error messages", async () => {
    const f = fixture();
    await expect(
      new HoodiProviderPool(
        { chainstack: "https://evil.example/secret" },
        f.fetcher,
      ).selectReadProvider(),
    ).rejects.toThrow("No verified");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(
      hoodiProviderUrls({
        PATIO_HOODI_CHAINSTACK_RPC_URL: urls.chainstack,
        QUICKNODE: "secret",
      }),
    ).toEqual({ chainstack: urls.chainstack });
  });
  it("a parser rejection is not sending/admission proof", async () => {
    const f = fixture();
    const delegate = f.fetcher;
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(requestBody(init)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      if (body.method === "eth_sendRawTransaction") {
        expect(body.params).toEqual(["0x"]);
        return Response.json({
          id: body.id,
          error: { code: -32000, message: "empty transaction" },
        });
      }
      return delegate(url, init);
    };
    expect(
      await new HoodiProviderPool(urls, fetcher).preflight("chainstack", true),
    ).toMatchObject({
      send: "invalid-input-rejected",
      publicTransport: "blocked",
    });
  });
  it("browser records and pins the selected provider; lease failure never reselects", async () => {
    let selections = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      if (!init?.body) {
        selections++;
        return await Promise.resolve(
          Response.json({
            provider: "chainstack",
            lease: "12345678-1234-1234-1234-123456789012",
          }),
        );
      }
      expect(init.headers).toMatchObject({
        "X-Patio-Provider-Lease": "12345678-1234-1234-1234-123456789012",
      });
      return Response.json(
        { error: { message: "Pinned provider unavailable" } },
        { status: 503 },
      );
    };
    const rpc = new BrowserEthereumRpc(
      { url: "/api/hoodi-external", providerSelection: true },
      fetcher,
    );
    await expect(rpc.chainId()).rejects.toThrow("Pinned provider");
    await expect(rpc.chainId()).rejects.toThrow("Pinned provider");
    expect(selections).toBe(1);
    expect(rpc.selectedProvider).toBe("chainstack");
  });
});

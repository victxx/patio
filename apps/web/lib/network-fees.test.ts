import { describe, it, expect } from "vitest";
import { NetworkFeeReader } from "./network-fees";
import { createRequiredDirectPlan } from "./direct-plan";
import { PATIO_NETWORK_PROFILES } from "@patio/config";
describe("independent network fee reads", () => {
  it("preserves provider selection, deduplicates reads and never calls a wallet", async () => {
    const methods: string[] = [];
    let selections = 0;
    const fetcher = async (_: unknown, init?: RequestInit) => {
      await Promise.resolve();
      if (!init?.body) {
        selections++;
        return Response.json({
          provider: "chainstack",
          lease: "00000000-0000-0000-0000-000000000001",
        });
      }
      expect(
        (init.headers as Record<string, string>)["X-Patio-Provider-Lease"],
      ).toBeTruthy();
      const { method } = JSON.parse(init.body as string) as { method: string };
      methods.push(method);
      return Response.json({
        result:
          method === "eth_chainId"
            ? "0x88bb0"
            : method === "eth_getBlockByNumber"
              ? { baseFeePerGas: "0x100000" }
              : "0x100000",
      });
    };
    const reader = new NetworkFeeReader(
      { url: "/api/hoodi-external", providerSelection: true },
      560048,
      fetcher,
    );
    await Promise.all([reader.refresh(), reader.refresh()]);
    expect(reader.state.fees).not.toBeNull();
    expect(selections).toBe(1);
    expect(methods).toHaveLength(3);
    await reader.refresh();
    expect(selections).toBe(1);
    expect(
      methods.every((m) =>
        [
          "eth_chainId",
          "eth_getBlockByNumber",
          "eth_maxPriorityFeePerGas",
        ].includes(m),
      ),
    ).toBe(true);
  });
  it("does not display another chain and marks old quotes stale on failure", async () => {
    let fail = false;
    let chain = "0x88bb0";
    const reader = new NetworkFeeReader(
      { url: "/read" },
      560048,
      async (_, init) => {
        await Promise.resolve();
        if (fail) throw Error("offline");
        const { method } = JSON.parse(init?.body as string) as {
          method: string;
        };
        return Response.json({
          result:
            method === "eth_chainId"
              ? chain
              : method === "eth_getBlockByNumber"
                ? { baseFeePerGas: "0x1" }
                : "0x1",
        });
      },
    );
    await reader.refresh();
    const previous = reader.state.fees;
    fail = true;
    expect(await reader.refresh()).toBeNull();
    expect(reader.state.error).toContain("Fee request failed");
    expect(reader.state.fees).toBe(previous);
    fail = false;
    chain = "0x1";
    expect(await reader.refresh()).toBeNull();
    expect(reader.state.fees).toBe(previous);
  });
  it("uses B2 exposure and reports affordability independently of successful fee reads", () => {
    const quote = (seconds: number, fee: bigint) =>
      createRequiredDirectPlan(
        fee,
        75_000_000n,
        seconds,
        undefined,
        3000,
        PATIO_NETWORK_PROFILES.hoodi,
        "classic-per-nonce-v2",
      );
    const short = quote(15, 1_040_000n)!;
    expect(short.feePlan).toHaveProperty(
      "exposurePolicy",
      "classic-per-nonce-v2",
    );
    expect(quote(30, 1_040_000n)!.requiredFundingWei).toBeGreaterThan(
      short.requiredFundingWei,
    );
    expect(quote(90, 100_000_000_000n)).toBeNull();
  });
});

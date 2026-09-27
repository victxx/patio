import { describe, expect, it, vi } from "vitest";
import { readClassicEnd, createClassicEndProbe } from "./classic-listener-end";
import {
  directSessionUrl,
  parseDirectSession,
  type BrowserEthereumRpc,
  type DirectSessionDescriptor,
} from "./direct-hoodi";

const descriptor: DirectSessionDescriptor = {
  version: 1,
  transportMode: "classic-v2",
  chainId: 560048,
  operator: "0x2222222222222222222222222222222222222222",
  sessionAddress: "0x3333333333333333333333333333333333333333",
  streamId: `0x${"ab".repeat(16)}`,
  nonceStart: "0",
  classicEnd: { mediaNonceEnd: "2", releaseHash: `0x${"cd".repeat(32)}` },
};

describe("non-blocking classic end probe", () => {
  it("does not stall media polling or duplicate slow canonical reads", async () => {
    let resolve!: (value: null) => void;
    const rpc = {
      receipt: vi.fn(
        () =>
          new Promise<null>((r) => {
            resolve = r;
          }),
      ),
    };
    let now = 0;
    const probe = createClassicEndProbe(
      rpc as unknown as BrowserEthereumRpc,
      descriptor,
      () => now,
    );
    expect(probe.poll()).toBeUndefined();
    now = 5_000;
    expect(probe.poll()).toBeUndefined();
    expect(rpc.receipt).toHaveBeenCalledTimes(1);
    resolve(null);
    await new Promise((r) => setTimeout(r, 0));
    probe.dispose();
    expect(probe.poll()?.ended).toBe(false);
    expect(rpc.receipt).toHaveBeenCalledTimes(1);
  });
});
function reader() {
  return {
    receipt: vi.fn(
      async () =>
        await Promise.resolve({
          transactionHash: descriptor.classicEnd!.releaseHash,
          blockNumber: "0x1",
          blockHash: "0xabc",
          status: "0x1",
        }),
    ),
    transaction: vi.fn(
      async () =>
        await Promise.resolve({
          hash: descriptor.classicEnd!.releaseHash,
          nonce: "0x0",
          from: descriptor.sessionAddress,
          to: descriptor.sessionAddress,
          value: "0x0",
          input: "0x",
          type: "0x2",
        }),
    ),
    request: vi.fn(
      async (
        method: string,
      ): Promise<string | { number: string; hash: string }> =>
        await Promise.resolve(
          method === "eth_getTransactionCount"
            ? "0x3"
            : { number: "0x2", hash: "0xabc" },
        ),
    ),
  };
}
describe("classic canonical end, no pending-release shortcut", () => {
  it("round trips new bounded metadata without changing PatioPacket", () => {
    expect(
      parseDirectSession(
        new URL(directSessionUrl("https://example.test", descriptor))
          .searchParams,
      ),
    ).toEqual(descriptor);
  });
  it("registry v1 links drain after canonical gap consumption without claiming all media consumed", async () => {
    const old = { ...descriptor };
    delete old.transportMode;
    delete old.classicEnd;
    const rpc = reader();
    expect(
      parseDirectSession(
        new URL(directSessionUrl("https://example.test", old)).searchParams,
      ),
    ).toEqual(old);
    expect(
      await readClassicEnd(rpc as unknown as BrowserEthereumRpc, old),
    ).toMatchObject({
      ended: true,
      reason: "legacy-gap-consumed-terminal-bound-unknown",
    });
    expect(rpc.receipt).not.toHaveBeenCalled();
    rpc.request.mockImplementation(
      async (method) =>
        await Promise.resolve(
          method === "eth_getTransactionCount"
            ? "0x0"
            : { number: "0x2", hash: "0xabc" },
        ),
    );
    expect(
      (await readClassicEnd(rpc as unknown as BrowserEthereumRpc, old)).ended,
    ).toBe(false);
  });
  it("pending release keeps receiving, even with pending nonce raised", async () => {
    const rpc = reader();
    vi.mocked(rpc.receipt).mockResolvedValue(null!);
    expect(
      (await readClassicEnd(rpc as unknown as BrowserEthereumRpc, descriptor))
        .ended,
    ).toBe(false);
    expect(rpc.request).not.toHaveBeenCalled();
  });
  it("canonical release alone cannot end unconsumed windows", async () => {
    const rpc = reader();
    rpc.request.mockImplementation(
      async (method) =>
        await Promise.resolve(
          method === "eth_getTransactionCount"
            ? "0x1"
            : { number: "0x2", hash: "0xabc" },
        ),
    );
    expect(
      (await readClassicEnd(rpc as unknown as BrowserEthereumRpc, descriptor))
        .ended,
    ).toBe(false);
  });
  it("canonical consumed range requests existing drain, never says finalized or retired atomically", async () => {
    expect(
      await readClassicEnd(
        reader() as unknown as BrowserEthereumRpc,
        descriptor,
      ),
    ).toMatchObject({
      ended: true,
      reason: "classic-media-nonces-consumed-not-finalized",
      nonce: "3",
    });
  });
  it("rejects changed canonical evidence and malformed terminal bounds", async () => {
    const rpc = reader();
    rpc.request.mockImplementation(
      async (method) =>
        await Promise.resolve(
          method === "eth_getTransactionCount"
            ? "0x3"
            : { number: "0x2", hash: "0xdef" },
        ),
    );
    await expect(
      readClassicEnd(rpc as unknown as BrowserEthereumRpc, descriptor),
    ).rejects.toThrow("reorg");
    const url = new URL(directSessionUrl("https://example.test", descriptor));
    url.searchParams.set("mediaEnd", "9999999");
    expect(parseDirectSession(url.searchParams)).toBeNull();
    url.searchParams.set("transport", "single-nonce-retirement-v1");
    expect(parseDirectSession(url.searchParams)).toBeNull();
  });
});

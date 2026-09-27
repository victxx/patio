import { describe, expect, it, vi } from "vitest";
import { observeClassicMedia } from "./classic-media-observation";
import type { Address, Hex } from "viem";

const address: Address = `0x${"11".repeat(20)}`;
const hash: Hex = `0x${"22".repeat(32)}`;
describe("advisory media observation (RPC doubles, no public sends)", () => {
  it("records only a matching transaction as observed", async () => {
    const rpc = {
      txpoolContentFrom: vi.fn(() =>
        Promise.resolve({
          queued: {
            "1": {
              hash,
              from: address,
              nonce: "0x1",
              input: "0xab",
            },
          },
          pending: {},
        }),
      ),
    };
    expect(await observeClassicMedia(rpc, address, hash)).toBe("observed");
    expect(rpc.txpoolContentFrom).toHaveBeenCalledWith(address);
  });
  it("does not poll 40 times or invent receipt on an empty snapshot", async () => {
    const rpc = {
      txpoolContentFrom: vi.fn(() =>
        Promise.resolve({ pending: {}, queued: {} }),
      ),
    };
    expect(await observeClassicMedia(rpc, address, hash)).toBe("not-observed");
    expect(rpc.txpoolContentFrom).toHaveBeenCalledTimes(1);
  });
  it("returns a distinct read failure without retrying submission", async () => {
    const rpc = {
      txpoolContentFrom: vi.fn(() => Promise.reject(new Error("rate limited"))),
    };
    expect(await observeClassicMedia(rpc, address, hash)).toBe("read-failed");
    expect(rpc.txpoolContentFrom).toHaveBeenCalledTimes(1);
  });
});

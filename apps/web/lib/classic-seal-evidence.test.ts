import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  matchesClassicSeal,
  readClassicSealEvidence,
} from "./classic-seal-evidence";
import type { RpcTransaction } from "./direct-hoodi";

const account: Address = `0x${"11".repeat(20)}`;
const hash: Hex = `0x${"22".repeat(32)}`;
const expected = {
  account,
  hash,
  chainId: 560048,
  nonce: 1n,
  maxFee: 100n,
  tip: 10n,
};
const seal = {
  hash,
  from: account,
  to: account,
  nonce: "0x1",
  value: "0x0",
  input: "0x",
  gas: "0x5208",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0xa",
  chainId: "0x88bb0",
  type: "0x2",
};
describe("classic empty seal evidence (read-only RPC doubles)", () => {
  it("uses exact validated lookup when the pool view omits the submitted seal", async () => {
    const rpc = {
      txpoolContentFrom: vi.fn(() =>
        Promise.resolve({ queued: {}, pending: {} }),
      ),
      transaction: vi.fn(() => Promise.resolve(seal as RpcTransaction)),
    };
    expect(await readClassicSealEvidence(rpc, expected)).toBe(true);
    expect(rpc.transaction).toHaveBeenCalledExactlyOnceWith(hash);
  });
  it("does not interpret a missing transaction as observed", async () => {
    const rpc = {
      txpoolContentFrom: () => Promise.reject(new Error("unavailable")),
      transaction: () => Promise.resolve(null),
    };
    expect(await readClassicSealEvidence(rpc, expected)).toBe(false);
  });
  it("rejects hash-only, other-account, media, different fees/nonce/chain and value-bearing responses", () => {
    expect(matchesClassicSeal(seal, expected)).toBe(true);
    for (const patch of [
      { hash: `0x${"33".repeat(32)}` },
      { from: hash },
      { to: hash },
      { nonce: "0x2" },
      { value: "0x1" },
      { input: "0xab" },
      { maxFeePerGas: "0x65" },
      { chainId: "0x1" },
    ])
      expect(matchesClassicSeal({ ...seal, ...patch }, expected)).toBe(false);
    expect(matchesClassicSeal({ hash }, expected)).toBe(false);
  });
});

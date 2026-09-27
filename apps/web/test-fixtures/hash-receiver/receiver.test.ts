import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { packetToHex } from "@patio/protocol";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HashReceiver,
  deliverHint,
  metadataHint,
  validateTransaction,
  type Context,
  type Hint,
} from "./receiver";
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const context: Context = {
  chainId: 1337,
  sessionAddress: account.address,
  streamId: `0x${"22".repeat(16)}`,
  nonce: 1,
  capacity: 4,
};
async function fixture(sequence = 0) {
  const data = packetToHex({
    version: 1,
    type: 2,
    codec: 1,
    flags: 0,
    streamId: context.streamId,
    windowIndex: 0,
    sequence,
    capturedAtMs: 0n,
    payload: new Uint8Array(6000).fill(65),
  });
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: 1337,
    nonce: 1,
    to: account.address,
    value: 0n,
    data,
    gas: 351720n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const parsed = parseTransaction(raw);
  const hint: Hint = {
    version: 1,
    chainId: 1337,
    sessionAddress: account.address,
    streamId: context.streamId,
    sequence,
    transactionHash: keccak256(raw),
  };
  const tx = {
    hash: hint.transactionHash,
    type: "0x2",
    chainId: "0x539",
    nonce: "0x1",
    value: "0x0",
    from: account.address,
    to: account.address,
    input: data,
    gas: toHex(351720n),
    maxFeePerGas: toHex(3_000_000_000n),
    maxPriorityFeePerGas: toHex(1_000_000_000n),
    accessList: [],
    r: parsed.r,
    s: parsed.s,
    yParity: toHex(parsed.yParity!),
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
  };
  return { hint, tx, data };
}
describe("R1 receiver: metadata is only an untrusted hint", () => {
  it("reconstructs hash and recovers signature; checks real packet bytes/checksum", async () => {
    const f = await fixture();
    const result = await validateTransaction(f.tx, f.hint, context);
    expect(result.digest).toBe(keccak256(f.data));
    expect(result.packet.payload).toEqual(new Uint8Array(6000).fill(65));
  });
  it.each(["chainId", "sessionAddress", "streamId"] as const)(
    "rejects wrong %s",
    async (key) => {
      const f = await fixture();
      expect(() =>
        metadataHint(
          {
            ...f.hint,
            [key]:
              key === "chainId"
                ? 1
                : `0x${"33".repeat(key === "streamId" ? 16 : 20)}`,
          },
          context,
        ),
      ).toThrow();
    },
  );
  it.each(["from", "nonce", "chainId", "input", "hash", "s"])(
    "rejects inconsistent transaction %s",
    async (key) => {
      const f = await fixture();
      await expect(
        validateTransaction({ ...f.tx, [key]: "0x3" }, f.hint, context),
      ).rejects.toThrow();
    },
  );
  it("does not accept included media as a live packet", async () => {
    const f = await fixture();
    await expect(
      validateTransaction({ ...f.tx, blockNumber: "0x1" }, f.hint, context),
    ).rejects.toThrow();
  });
  it("never transports payload or arbitrary extras in bus", async () => {
    const f = await fixture();
    const read = vi.fn();
    expect(() =>
      deliverHint(new HashReceiver(context, read), {
        ...f.hint,
        calldata: f.data,
      }),
    ).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("deduplicates identical hints without dropping an out-of-order valid sequence", async () => {
    const a = await fixture(2),
      b = await fixture(0);
    const read = vi.fn((h: Hex) =>
      Promise.resolve(h === a.hint.transactionHash ? a.tx : b.tx),
    );
    const r = new HashReceiver(context, read);
    await Promise.all([
      r.receive(a.hint),
      r.receive(a.hint),
      r.receive(b.hint),
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(r.metrics.map((m) => m.sequence)).toEqual([2, 0]);
    expect(JSON.stringify(r.metrics)).not.toContain("input");
  });
  it("null remains unknown; retries are bounded", async () => {
    const f = await fixture();
    const read = vi.fn(() => Promise.resolve(null));
    const r = new HashReceiver(context, read, 3, 0);
    expect(await r.receive(f.hint)).toEqual({
      outcome: "unavailable-not-dropped",
    });
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("a false sequence hint cannot poison the correct hint for that hash", async () => {
    const f = await fixture();
    const r = new HashReceiver(context, () => Promise.resolve(f.tx));
    expect(await r.receive({ ...f.hint, sequence: 1 })).toEqual({
      outcome: "invalid-or-read-failure",
    });
    expect(await r.receive(f.hint)).toMatchObject({
      outcome: "validated-unincluded",
    });
  });
  it("stale completion after stop cannot validate into a new session", async () => {
    const f = await fixture();
    let resolve!: (v: unknown) => void;
    const r = new HashReceiver(
      context,
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const p = r.receive(f.hint);
    r.stop();
    resolve(f.tx);
    expect(await p).toEqual({ outcome: "stopped" });
  });
  it("caps concurrent requests and retained metadata", async () => {
    const f = await fixture();
    const r = new HashReceiver(context, () => Promise.resolve(null), 1, 0);
    for (let i = 0; i < 40; i++)
      await r.receive({
        ...f.hint,
        transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
      });
    expect(r.metrics).toHaveLength(32);
    const stalled = new HashReceiver(context, () => new Promise(() => {}));
    const p = stalled.receive(f.hint);
    const q = stalled.receive({
      ...f.hint,
      transactionHash: `0x${"ff".repeat(32)}`,
    });
    expect(
      await stalled.receive({
        ...f.hint,
        transactionHash: `0x${"ee".repeat(32)}`,
      }),
    ).toEqual({ outcome: "bounded-or-stopped" });
    stalled.stop();
    await Promise.all([p, q]);
  });
  it("receiver has no sending/pool or URL-selecting API", () => {
    const source = readFileSync(
      new URL("./receiver.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /eth_sendRawTransaction|txpool_|fetch\(|signTransaction|https?:\/\//,
    );
  });
});

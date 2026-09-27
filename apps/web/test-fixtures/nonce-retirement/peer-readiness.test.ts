import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  monitorPrivatePeers,
  PeerStabilityWindow,
  samplePrivatePeers,
  type PeerSample,
} from "./peer-readiness";
import { CLIENTS } from "./private-client";

const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)] as [
  string,
  string,
  string,
];
const manifest = {
  kind: "patio-owned-prague-fixture" as const,
  chainId: 1337 as const,
  genesisHash: `0x${"1".repeat(64)}` as const,
  nodeIds: ids,
};
function fixtures() {
  const peers = ids.map((_, i) =>
    ids
      .filter((_, j) => j !== i)
      .map((id) => ({
        id,
        network: {
          inbound: false,
          localAddress: "127.0.0.1:1",
          remoteAddress: "127.0.0.1:2",
          static: true,
        },
      })),
  );
  const requests = ids.map((id, i) =>
    vi.fn(async (method: string): Promise<unknown> => {
      const client = i === 0 ? CLIENTS.nethermind : CLIENTS.geth;
      const values: Record<string, unknown> = {
        eth_chainId: "0x539",
        eth_getBlockByNumber: { hash: manifest.genesisHash },
        admin_nodeInfo: { id, name: `${client.version}-${client.commit}` },
        admin_peers: peers[i],
        eth_syncing: false,
        eth_blockNumber: "0x1",
      };
      if (!(method in values)) throw new Error("Unexpected RPC");
      return await Promise.resolve(values[method]);
    }),
  );
  const nodes = requests.map((request) => ({
    rpc: <T>(method: string) => request(method) as Promise<T>,
  }));
  return { peers, nodes, requests };
}
afterEach(() => vi.useRealTimers());
describe("private fixture stable readiness", () => {
  it("requires 12 continuous seconds, not a single handshake or head change", async () => {
    const f = fixtures();
    const sample = await samplePrivatePeers(manifest, f.nodes);
    const gate = new PeerStabilityWindow();
    for (let t = 0; t < 12000; t += 1000) {
      gate.observe(
        sample.map((s) => ({ ...s, head: String(t) })),
        t,
      );
      expect(() => gate.requireReady(t)).toThrow("blocked");
    }
    gate.observe(sample, 12000);
    expect(() => gate.requireReady(12000)).not.toThrow();
    expect(() => gate.requireReady(15000)).toThrow("stale");
  });
  it("connection replacement and sampling gaps restart the entire window", async () => {
    const f = fixtures();
    const sample = await samplePrivatePeers(manifest, f.nodes);
    const gate = new PeerStabilityWindow();
    for (let t = 0; t <= 12000; t += 1000) gate.observe(sample, t);
    const reconnected: PeerSample[] = structuredClone(sample);
    reconnected[0]!.peers[0]!.remote = "127.0.0.1:9999";
    gate.observe(reconnected, 13000);
    expect(() => gate.requireReady(13000)).toThrow("window");
    gate.observe(reconnected, 30000);
    expect(() => gate.requireReady(30000)).toThrow("window");
  });
  it("missing B names the broken link, never authorizes funding", async () => {
    const f = fixtures();
    f.peers[0] = f.peers[0]!.filter((p) => p.id !== ids[1]);
    const fund = vi.fn();
    await expect(
      samplePrivatePeers(manifest, f.nodes).then(fund),
    ).rejects.toThrow("A↔B missing");
    expect(fund).not.toHaveBeenCalled();
  });
  it("unexpected peers and wrong chain/genesis/client/identity/sync fail closed", async () => {
    for (const [method, value] of [
      ["eth_chainId", "0x88bb0"],
      ["eth_getBlockByNumber", { hash: "0x00" }],
      ["admin_nodeInfo", { id: ids[0], name: "Geth wrong" }],
      ["eth_syncing", {}],
      ["admin_peers", [...fixtures().peers[0]!, { id: "unexpected" }]],
    ] as const) {
      const f = fixtures();
      const original = f.requests[0]!.getMockImplementation()!;
      f.requests[0]!.mockImplementation(async (m: string) =>
        m === method ? value : await original(m),
      );
      await expect(samplePrivatePeers(manifest, f.nodes)).rejects.toThrow();
    }
  });
  it("monitor detects loss after readiness and cancels timers/late responses", async () => {
    vi.useFakeTimers();
    const f = fixtures();
    const seen = vi.fn();
    const monitor = monitorPrivatePeers(manifest, f.nodes, seen);
    await vi.advanceTimersByTimeAsync(13000);
    await expect(monitor.requireReady()).resolves.toBeUndefined();
    f.peers[0] = [];
    await expect(monitor.requireReady()).rejects.toThrow("A↔B");
    monitor.stop();
    const count = seen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(seen).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    await expect(monitor.requireReady()).rejects.toThrow("stopped");
  });
  it("stopped monitor cannot certify an outstanding asynchronous read", async () => {
    const f = fixtures();
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    f.requests[0]!.mockImplementation(async () => await pending);
    const seen = vi.fn();
    const monitor = monitorPrivatePeers(manifest, f.nodes, seen);
    monitor.stop();
    resolve(null);
    await Promise.resolve();
    await expect(monitor.requireReady()).rejects.toThrow("stopped");
    expect(seen).not.toHaveBeenCalled();
  });
  it("full-app fixture gates preparation and funding before signing; no public change", () => {
    const source = readFileSync(
      new URL("./full-app-server.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('"client-default"');
    const funding = source.slice(source.indexOf('req.url === "/fund"'));
    expect(funding.indexOf("peerReadiness!.requireReady()")).toBeLessThan(
      funding.indexOf("operator.signTransaction"),
    );
    expect(source).toMatch(
      /req.url === "\/prepared"\) \{\s+await peerReadiness!\.requireReady\(\)/,
    );
  });
});

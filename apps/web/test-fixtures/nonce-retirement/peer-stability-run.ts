/** H2.6.1: real private P2P only. Never creates a Patio session. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CLIENTS,
  fixtureGenesis,
  startPrivateClient,
  type PrivateClient,
  type Block,
} from "./private-client";

const report = process.env.PATIO_H261_REPORT;
assert(report?.startsWith("/"), "Explicit local metadata report required");
const nodes: PrivateClient[] = [];
const control = privateKeyToAccount(generatePrivateKey());
const genesis = fixtureGenesis({ [control.address]: 10n ** 18n });
const evidence = {
  mode: "historical-idle",
  clients: CLIENTS,
  chainId: 1337,
  fork: "Prague",
  startedAt: new Date().toISOString(),
  genesisHash: "",
  nodes: [] as {
    label: string;
    id: string;
    directory: string;
    logPath: string;
  }[],
  samples: [] as unknown[],
  logs: [] as { node: string; lines: string[] }[],
  failure: undefined as string | undefined,
};
async function main() {
  const infos: { id: string; enode: string }[] = [];
  for (const [i, client] of (
    ["nethermind", "geth", "geth"] as const
  ).entries()) {
    const binary = process.env[CLIENTS[client].env];
    assert(binary?.startsWith("/"));
    const node = await startPrivateClient(client, binary!, genesis, i, true);
    nodes.push(node);
    const info = await node.rpc<{ id: string; enode: string }>(
      "admin_nodeInfo",
    );
    infos.push(info);
    const block = await node.rpc<Block>("eth_getBlockByNumber", ["0x0", false]);
    if (evidence.genesisHash) assert.equal(block.hash, evidence.genesisHash);
    evidence.genesisHash = block.hash;
    evidence.nodes.push({
      label: "ABC"[i]!,
      id: info.id,
      directory: node.directory,
      logPath: node.logPath,
    });
  }
  assert.equal(new Set(infos.map((n) => n.id)).size, 3);
  await nodes[2]!.buildBlock([nodes[0]!, nodes[1]!]);
  for (const [from, to] of [
    [1, 0],
    [0, 2],
    [1, 2],
  ]) {
    await nodes[from!]!.rpc("admin_addPeer", [
      `${infos[to!]!.enode.split("@")[0]}@${to === 0 ? "[::1]" : "127.0.0.1"}:${18649 + to! * 10}`,
    ]);
  }
  for (let i = 0; i < 150; i++) {
    const counts = await Promise.all(
      nodes.map((n) => n.rpc<string>("net_peerCount")),
    );
    if (counts.every((n) => BigInt(n) === 2n)) break;
    assert(i < 149, "Initial handshake incomplete");
    await delay(100);
  }
  // EXACT H2.6 attempt: late static registration, after inbound handshake.
  await nodes[0]!.rpc("admin_addPeer", [
    `${infos[1]!.enode.split("@")[0]}@127.0.0.1:18659`,
  ]);
  const origin = performance.now();
  while (performance.now() - origin < 75_000) {
    const peers = await Promise.all(
      nodes.map((n) =>
        n.rpc<{ id: string; name: string; network: unknown }[]>("admin_peers"),
      ),
    );
    evidence.samples.push({
      atMs: performance.now() - origin,
      at: new Date().toISOString(),
      peers: peers.map((ps, i) => ({
        node: "ABC"[i],
        peers: ps.map(({ id, name, network }) => ({ id, name, network })),
      })),
    });
    if (evidence.samples.length % 10 === 1)
      console.error(
        `Private peer sample ${evidence.samples.length}: ${peers.map((p) => p.length).join("/")}`,
      );
    await delay(1000);
  }
}
async function run() {
  try {
    await main();
  } catch (error) {
    evidence.failure =
      error instanceof Error ? error.message : "Private test failed";
    process.exitCode = 1;
  } finally {
    // Capture BEFORE intentionally stopping owned nodes: teardown is not a soak disconnect.
    for (const [i, node] of nodes.entries()) {
      const lines = readFileSync(node.logPath, "utf8")
        .split("\n")
        .filter((line) =>
          /Reviewing|PEER REVIEW|DropWorst|PeerCount:|PeerMaxCount:|Static node|Throttling discovery|filtered IP|Removing p2p peer|Adding p2p peer|Disconnected|disconnect|All active peers/i.test(
            line,
          ),
        );
      evidence.logs.push({ node: "ABC"[i]!, lines: lines.slice(-250) });
    }
    writeFileSync(report!, JSON.stringify(evidence, null, 2));
    await Promise.all(nodes.map((n) => n.stop()));
    console.error(`Private peer evidence: ${report}`);
  }
}
void run();

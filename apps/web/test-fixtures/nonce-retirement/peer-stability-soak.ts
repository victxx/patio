/** H2.6.1: ordinary control accounts only; no Patio session/media/close/sweep. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CLIENTS,
  fixtureGenesis,
  startPrivateClient,
  type PrivateClient,
  type Block,
} from "./private-client";
import { monitorPrivatePeers, type PeerSample } from "./peer-readiness";

async function trial(negative: boolean, repetition: number) {
  const nodes: PrivateClient[] = [];
  const control = privateKeyToAccount(generatePrivateKey());
  const genesis = fixtureGenesis({ [control.address]: 10n ** 18n });
  let monitor: ReturnType<typeof monitorPrivatePeers> | undefined;
  let previousConnection: string | undefined;
  const origin = performance.now();
  const evidence = {
    repetition,
    clients: CLIENTS,
    chainId: 1337,
    fork: "Prague",
    maxActivePeers: 50,
    startedAt: new Date().toISOString(),
    genesisHash: "",
    nodes: [] as {
      label: string;
      id: string;
      directory: string;
      logPath: string;
    }[],
    samples: [] as { atMs: number; at: string; peers: PeerSample[] }[],
    logs: [] as { node: string; lines: string[] }[],
    controls: [] as {
      hash: Hex;
      nonce: number;
      ingress: string;
      observedBy: string[];
    }[],
    blocks: [] as { hash: Hex; number: Hex; transactions: Hex[] }[],
    stableDurationMs: 0,
    connectionChanges: 0,
    negative: undefined as
      undefined | { reason: string; fundingCallbackCalled: boolean },
    failure: undefined as string | undefined,
  };
  const sample = (peers: PeerSample[]) => {
    const connection = JSON.stringify(
      peers.map((p) => [
        p.node,
        p.peers.map((n) => [n.id, n.inbound, n.local, n.remote]),
      ]),
    );
    if (previousConnection && previousConnection !== connection)
      evidence.connectionChanges++;
    previousConnection = connection;
    if (evidence.samples.length < 800)
      evidence.samples.push({
        atMs: performance.now() - origin,
        at: new Date().toISOString(),
        peers,
      });
  };
  try {
    const infos: { id: string; enode: string }[] = [];
    for (const [i, client] of (
      ["nethermind", "geth", "geth"] as const
    ).entries()) {
      const binary = process.env[CLIENTS[client].env];
      assert(binary?.startsWith("/"));
      const node = await startPrivateClient(
        client,
        binary!,
        genesis,
        i,
        true,
        "client-default",
      );
      nodes.push(node);
      const info = await node.rpc<{ id: string; enode: string }>(
        "admin_nodeInfo",
      );
      infos.push(info);
      const block = await node.rpc<Block>("eth_getBlockByNumber", [
        "0x0",
        false,
      ]);
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
    // Same late registration as H2.6; do NOT rely on promotion to static.
    await nodes[0]!.rpc("admin_addPeer", [
      `${infos[1]!.enode.split("@")[0]}@127.0.0.1:18659`,
    ]);
    monitor = monitorPrivatePeers(
      {
        kind: "patio-owned-prague-fixture",
        chainId: 1337,
        genesisHash: evidence.genesisHash as Hex,
        nodeIds: infos.map((n) => n.id) as [string, string, string],
      },
      nodes,
      sample,
    );
    await monitor.waitReady();
    console.error(`Trial ${repetition}: stable readiness reached`);
    if (negative) {
      await nodes[1]!.stop();
      let fundingCallbackCalled = false;
      try {
        await monitor.requireReady();
        fundingCallbackCalled = true; // sentinel only: no funding implementation
      } catch (error) {
        evidence.negative = {
          reason: error instanceof Error ? error.message : "Unknown",
          fundingCallbackCalled,
        };
      }
      assert(evidence.negative && !fundingCallbackCalled);
      assert.match(evidence.negative.reason, /B/);
    } else {
      const start = performance.now();
      let nextBlock = 0,
        nextControl = 0,
        nonce = 0;
      while (performance.now() - start < 150_000) {
        await monitor.requireReady();
        if (performance.now() - start >= nextControl) {
          const raw = await control.signTransaction({
            type: "eip1559",
            chainId: 1337,
            nonce,
            to: control.address,
            value: 0n,
            data: "0x",
            gas: 21000n,
            maxFeePerGas: 3_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n,
          });
          const hash = keccak256(raw);
          assert.equal(
            await nodes[0]!.rpc("eth_sendRawTransaction", [raw]),
            hash,
          );
          const observedBy: string[] = [];
          for (let i = 0; i < 3; i++) {
            const deadline = performance.now() + 10_000;
            let found = false;
            while (performance.now() < deadline) {
              const pool = await nodes[i]!.rpc("txpool_content");
              if (JSON.stringify(pool).includes(hash)) {
                found = true;
                break;
              }
              await delay(100);
            }
            assert(found, `Control missing from ${"ABC"[i]} pool`);
            observedBy.push("ABC"[i]!);
          }
          evidence.controls.push({
            hash,
            nonce: nonce++,
            ingress: "A only",
            observedBy,
          });
          nextControl += 25_000;
        }
        if (performance.now() - start >= nextBlock) {
          evidence.blocks.push(
            await nodes[2]!.buildBlock([nodes[0]!, nodes[1]!]),
          );
          nextBlock += 6_000;
        }
        await Promise.all(
          nodes.flatMap((n) => [
            n.rpc("eth_getBalance", [control.address, "latest"]),
            n.rpc("eth_getTransactionCount", [control.address, "latest"]),
            n.rpc("eth_getCode", [control.address, "latest"]),
            n.rpc("eth_getBlockByNumber", ["latest", false]),
            n.rpc("eth_maxPriorityFeePerGas"),
          ]),
        );
        await delay(750);
      }
      evidence.stableDurationMs = performance.now() - start;
      await monitor.requireReady();
      assert.equal(evidence.connectionChanges, 0);
      for (const tx of evidence.controls)
        assert.equal((await nodes[2]!.readReceipt(tx.hash))?.status, "0x1");
    }
  } catch (error) {
    evidence.failure =
      error instanceof Error ? error.message : "Private test failed";
  } finally {
    monitor?.stop();
    // Snapshot BEFORE intentional teardown, which is not a soak disconnect.
    for (const [i, node] of nodes.entries()) {
      const lines = readFileSync(node.logPath, "utf8")
        .split("\n")
        .filter((line) =>
          /Reviewing|PEER REVIEW|DropWorst|PeerCount:|PeerMaxCount:|Static node|Throttling discovery|filtered IP|Removing p2p peer|Adding p2p peer|disconnected (Local|Remote)/i.test(
            line,
          ),
        );
      evidence.logs.push({ node: "ABC"[i]!, lines: lines.slice(-350) });
      if (
        !negative &&
        lines.some((line) =>
          /Removing p2p peer|disconnected (Local|Remote)/.test(line),
        )
      )
        evidence.failure ??= `${"ABC"[i]}: disconnect recorded before teardown`;
    }
    await Promise.all(nodes.map((n) => n.stop()));
  }
  return evidence;
}

async function main() {
  const report = process.env.PATIO_H261_REPORT;
  assert(
    report && report.startsWith("/"),
    "Explicit local metadata report required",
  );
  const negative = process.env.PATIO_H261_NEGATIVE === "1";
  const results = [];
  for (let i = 1; i <= (negative ? 1 : 3); i++) {
    const result = await trial(negative, i);
    results.push(result);
    writeFileSync(
      report,
      JSON.stringify(
        { nodeVersion: process.version, publicNetwork: "NOT RUN", results },
        null,
        2,
      ),
    );
    console.error(
      `Trial ${i}: ${result.failure ?? "PASS"}; ${result.stableDurationMs}ms`,
    );
    if (result.failure) {
      process.exitCode = 1;
      break;
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

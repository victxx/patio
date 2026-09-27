/** H2.5: production transport with synthetic packets, owned private processes only. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { packetFromHex, PatioCodec, PatioPacketType } from "@patio/protocol";
import {
  PrivateRetirementEnvironment,
  type PrivateRetirementRpc,
} from "../../lib/private-retirement-environment";
import { SingleNonceTransport } from "../../lib/single-nonce-transport";
import { flattenTxpoolTransactions } from "../../lib/direct-hoodi";
import {
  CLIENTS,
  fixtureGenesis,
  startPrivateClient,
  type PrivateClient,
  type Block,
} from "./private-client";

async function trial(repetition: number) {
  const nodes: PrivateClient[] = [];
  const info: { id: string; enode: string }[] = [];
  const operator = privateKeyToAccount(generatePrivateKey());
  const genesis = fixtureGenesis({ [operator.address]: 10n ** 18n });
  const observations: unknown[] = [];
  const blocks: { hash: Hex; number: Hex; transactions: Hex[] }[] = [];
  const origin = performance.now();
  const sends: { node: string; method: string; hash: Hex }[] = [];
  let transport: SingleNonceTransport | undefined;
  let stage = "private-launch";
  let failure: string | undefined;
  let finalBalance: Hex | undefined;
  let genesisHash: Hex | undefined;
  async function pool(i: number) {
    return flattenTxpoolTransactions(await nodes[i]!.rpc("txpool_content"));
  }
  async function observe(i: number, hash: Hex, role: string) {
    for (let n = 0; n < 150; n++) {
      const tx = (await pool(i)).find((t) => t.hash === hash);
      if (tx) {
        const packet = role === "media" ? packetFromHex(tx.input) : undefined;
        if (packet) {
          assert.equal(packet.streamId, transport!.descriptor.streamId);
          assert.equal(packet.windowIndex, 0);
          assert.equal(packet.payload.length, 6000);
        }
        observations.push({
          node: "ABC"[i],
          hash,
          role,
          nonce: tx.nonce,
          sequence: packet?.sequence,
          atMs: performance.now() - origin,
          source:
            i === (role === "media" || role === "funding" ? 0 : 1)
              ? "RPC"
              : "P2P",
        });
        return;
      }
      await delay(100);
    }
    throw new Error(`Exact ${role} absent from ${"ABC"[i]} pool`);
  }
  async function build() {
    const block = await nodes[2]!.buildBlock(nodes.slice(0, 2));
    const media =
      transport?.snapshot().signatures.filter((s) => s.role === "media") ?? [];
    assert(
      media.every((s) => !block.transactions.includes(s.hash)),
      "SAFETY FAILURE: media included",
    );
    blocks.push(block);
    return block;
  }
  try {
    for (const [i, client] of (
      ["nethermind", "geth", "geth"] as const
    ).entries()) {
      const binary = process.env[CLIENTS[client].env];
      assert(binary?.startsWith("/"));
      const node = await startPrivateClient(client, binary!, genesis, i, true);
      nodes.push(node);
      info.push(await node.rpc("admin_nodeInfo"));
      const actual = await node.rpc<Block>("eth_getBlockByNumber", [
        "0x0",
        false,
      ]);
      if (genesisHash) assert.equal(actual.hash, genesisHash);
      genesisHash = actual.hash;
    }
    await build();
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const from = i === 0 && j === 1 ? 1 : i;
        const to = from === j ? i : j;
        await nodes[from]!.rpc("admin_addPeer", [
          `${info[to]!.enode.split("@")[0]}@${to === 0 ? "[::1]" : "127.0.0.1"}:${18649 + to * 10}`,
        ]);
      }
    for (let n = 0; n < 150; n++) {
      const counts = await Promise.all(
        nodes.map((node) => node.rpc<Hex>("net_peerCount")),
      );
      if (counts.every((c) => BigInt(c) === 2n)) break;
      if (n === 149) throw new Error("Private peer handshake incomplete");
      await delay(100);
    }
    const endpoints = nodes.map((node, i): PrivateRetirementRpc => ({
      async request<T>(
        method: string,
        params: readonly unknown[] = [],
      ): Promise<T> {
        if (method === "eth_sendRawTransaction") {
          assert.notEqual(i, 2, "Observer can never receive an RPC submission");
          sends.push({
            node: "ABC"[i]!,
            method,
            hash: keccak256(params[0] as Hex),
          });
        }
        return node.rpc<T>(method, [...params]);
      },
    }));
    stage = "attestation";
    const env = await PrivateRetirementEnvironment.attest(
      {
        kind: "patio-owned-prague-fixture",
        chainId: 1337,
        genesisHash: genesisHash!,
        nodeIds: info.map((i) => i.id) as [string, string, string],
      },
      endpoints as [
        PrivateRetirementRpc,
        PrivateRetirementRpc,
        PrivateRetirementRpc,
      ],
    );
    stage = "prepare/fund";
    transport = await SingleNonceTransport.prepare(env, {
      operator: operator.address,
      candidates: 4,
      budget: 5_000_000_000_000_000n,
    });
    await transport.fund(async (address, value) => {
      const raw = await operator.signTransaction({
        type: "eip1559",
        chainId: 1337,
        nonce: 0,
        to: address,
        value,
        gas: 21000n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
      const hash = keccak256(raw);
      assert.equal(
        await endpoints[0]!.request("eth_sendRawTransaction", [raw]),
        hash,
      );
      await observe(2, hash, "funding");
      assert((await build()).transactions.includes(hash));
    });
    transport.start();
    stage = "media";
    for (let sequence = 0; sequence < 4; sequence++) {
      const payload = Uint8Array.from(
        { length: 6000 },
        (_, i) => (i * 17 + sequence) % 256,
      );
      const hash = await transport.sendMedia(
        payload,
        sequence === 0 ? PatioPacketType.START : PatioPacketType.AUDIO,
        PatioCodec.OPUS_WEBM,
        BigInt(sequence * 3000),
      );
      for (let i = 0; i < 3; i++) await observe(i, hash, "media");
      for (let i = 0; i < 3; i++)
        assert.equal(
          (await pool(i)).filter(
            (t) =>
              t.from.toLowerCase() ===
              transport!.descriptor.sessionAddress.toLowerCase(),
          ).length,
          1,
        );
    }
    stage = "retirement/sweep";
    let stopped = false;
    let stopError: unknown;
    const stop = transport
      .stop()
      .catch((error) => {
        stopError = error;
      })
      .finally(() => {
        stopped = true;
      });
    const selected = new Set<Hex>();
    for (let n = 0; n < 250 && !stopped; n++) {
      const snapshot = transport.snapshot();
      for (const [role, hash] of [
        ["retirement-close", snapshot.closeHash],
        ["sweep", snapshot.sweepHash],
      ] as const) {
        if (!hash || selected.has(hash)) continue;
        if (
          role === "retirement-close" &&
          !snapshot.events.some(
            (e) => e.hash === hash && e.stage === "observed",
          )
        )
          continue;
        if (!(await pool(2)).some((t) => t.hash === hash)) continue;
        await observe(2, hash, role);
        const block = await build();
        assert(block.transactions.includes(hash));
        selected.add(hash);
      }
      await delay(100);
    }
    await stop;
    if (stopError)
      throw stopError instanceof Error
        ? stopError
        : new Error("Retirement failed");
    assert.equal(transport.snapshot().state, "complete");
    assert.equal(
      await nodes[2]!.rpc("eth_getTransactionCount", [
        transport.descriptor.sessionAddress,
        "latest",
      ]),
      "0x3",
    );
    assert.equal(
      await nodes[2]!.rpc("eth_getCode", [
        transport.descriptor.sessionAddress,
        "latest",
      ]),
      "0x",
    );
    finalBalance = await nodes[2]!.rpc<Hex>("eth_getBalance", [
      transport.descriptor.sessionAddress,
      "latest",
    ]);
    const snapshot = transport.snapshot();
    const cost = snapshot.receipts.reduce(
      (sum, r) => sum + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice),
      0n,
    );
    const sweepTx = await nodes[2]!.rpc<{ value: Hex }>(
      "eth_getTransactionByHash",
      [snapshot.sweepHash],
    );
    assert.equal(
      transport.plan.requiredExposure,
      cost + BigInt(sweepTx.value) + BigInt(finalBalance),
    );
    observations.push({
      reconciliation: {
        funding: String(transport.plan.requiredExposure),
        cost: String(cost),
        returned: String(BigInt(sweepTx.value)),
        remaining: String(BigInt(finalBalance)),
        head: toHex(blocks.length),
      },
    });
  } catch (error) {
    failure =
      error instanceof Error ? error.message : "Unknown fixture failure";
  } finally {
    for (const node of nodes.reverse()) await node.stop();
  }
  return {
    repetition,
    status: failure ? "FAIL" : "PASS",
    stage,
    failure,
    genesisHash,
    chainId: 1337,
    fork: "Prague",
    clients: CLIENTS,
    identities: info.map((i) => i.id),
    sends,
    observations,
    blocks,
    transport: transport?.snapshot(),
    finalBalance,
  };
}

async function main() {
  const results = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    const result = await trial(repetition);
    results.push(result);
    if (result.status !== "PASS") break;
  }
  console.log(
    JSON.stringify(
      {
        publicNetwork: "NOT RUN",
        topology: "Nethermind A → Geth B/C; close B → C builder",
        results,
      },
      null,
      2,
    ),
  );
  if (results.some((r) => r.status !== "PASS")) process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/** H2.4 PRIVATE integration experiment. Never imported by production. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  parseTransaction,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  decodePatioPacket,
  encodePatioPacket,
  PatioCodec,
  PatioPacketType,
} from "@patio/protocol";
import {
  buildRetirementCandidate,
  validateRetirementSignatures,
} from "./candidate";
import {
  CLIENTS,
  fixtureGenesis,
  startPrivateClient,
  type Block,
  type PrivateClient,
} from "./private-client";

type Topology = "geth-geth" | "nethermind-geth-geth";
type Stage =
  "infrastructure" | "media" | "close" | "inclusion" | "safety" | "sweep";
interface PoolTx {
  hash: Hex;
  nonce: Hex;
  type: Hex;
  input: Hex;
  from: Hex;
}
interface NodeInfo {
  id: string;
  enode: string;
  name: string;
  ports: { listener: number };
}
const allocation = 10n ** 18n;
const fees = {
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};
const timeoutMs = 15_000;

async function trial(topology: Topology, repetition: number) {
  console.error(`Private P2P trial: ${topology}, repetition ${repetition}`);
  const nodes: PrivateClient[] = [];
  const info: NodeInfo[] = [];
  const observations: unknown[] = [];
  const sends: {
    node: string;
    role: string;
    hash: Hex;
    returnedHash?: Hex;
    error?: string;
    atMs: number;
  }[] = [];
  const blocks: unknown[] = [];
  const origin = performance.now();
  let stage: Stage = "infrastructure";
  let step = "launch";
  let outcome: unknown = null;
  let genesisHash: Hex | null = null;
  let peers: unknown[] = [];
  const session = privateKeyToAccount(generatePrivateKey());
  const control = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const streamId = bytesToHex(randomBytes(16));
  const genesis = fixtureGenesis({
    [session.address]: allocation,
    [control.address]: allocation,
  });
  const media: { raw: Hex; hash: Hex; sequence: number; data: Hex }[] = [];
  const closeEntry = topology === "geth-geth" ? 0 : 1;
  const receiver = topology === "geth-geth" ? 1 : 2;
  const name = (i: number) => String.fromCharCode(65 + i);
  async function pool(i: number) {
    const content =
      await nodes[i]!.rpc<
        Record<string, Record<string, Record<string, PoolTx>>>
      >("txpool_content");
    return Object.values(content).flatMap((accounts) =>
      Object.values(accounts).flatMap((entries) => Object.values(entries)),
    );
  }
  async function submit(
    i: number,
    role: "control" | "media" | "close" | "sweep",
    raw: Hex,
  ) {
    assert.equal(i, role === "control" || role === "media" ? 0 : closeEntry);
    assert.notEqual(
      i,
      receiver,
      "Receiver must never be an RPC submission endpoint",
    );
    const entry: (typeof sends)[number] = {
      node: name(i),
      role,
      hash: keccak256(raw),
      atMs: performance.now() - origin,
    };
    sends.push(entry);
    try {
      entry.returnedHash = await nodes[i]!.rpc<Hex>("eth_sendRawTransaction", [
        raw,
      ]);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "RPC unavailable";
      throw error;
    }
    assert.equal(entry.returnedHash, entry.hash);
    return entry;
  }
  async function observe(
    i: number,
    hash: Hex,
    role: string,
    sequence?: number,
  ) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const tx = (await pool(i)).find((tx) => tx.hash === hash);
      if (tx) {
        const head = await nodes[i]!.rpc<Block>("eth_getBlockByNumber", [
          "latest",
          false,
        ]);
        if (role === "media") {
          const packet = decodePatioPacket(hexToBytes(tx.input));
          assert.equal(packet.streamId, streamId);
          assert.equal(packet.sequence, sequence);
          assert.equal(packet.windowIndex, 0);
          assert.equal(packet.payload.length, 6000);
          assert.equal(tx.nonce, "0x1");
          assert.equal(tx.type, "0x2");
          assert.equal(tx.from.toLowerCase(), session.address.toLowerCase());
        }
        const observation = {
          node: name(i),
          role,
          hash,
          nonce: tx.nonce,
          type: tx.type,
          sequence,
          atMs: performance.now() - origin,
          pollWaitMs: performance.now() - started,
          block: { number: head.number, hash: head.hash },
          via:
            i === (role === "media" || role === "control" ? 0 : closeEntry)
              ? "local RPC admission"
              : "P2P only",
          ...(role === "media"
            ? {
                packetValidated: true,
                packetBytes: hexToBytes(tx.input).length,
              }
            : {}),
        };
        observations.push(observation);
        return;
      }
      await delay(100);
    }
    throw new Error(
      `Exact ${role} hash ${hash} absent from node ${name(i)} pool after ${timeoutMs} ms`,
    );
  }
  async function build() {
    const block = await nodes[receiver]!.buildBlock(
      nodes.filter((_, i) => i !== receiver),
    );
    for (const node of nodes) {
      const head = await node.rpc<Block>("eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      assert.equal(head.hash, block.hash);
    }
    assert(
      media.every((tx) => !block.transactions.includes(tx.hash)),
      "SAFETY FAILURE: media selected/included",
    );
    blocks.push({
      ...block,
      builder: name(receiver),
      otherNodes:
        "validated/imported via Engine API, not proof of pending gossip",
    });
    return block;
  }
  try {
    const clients =
      topology === "geth-geth"
        ? (["geth", "geth"] as const)
        : (["nethermind", "geth", "geth"] as const);
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i]!;
      const binary = process.env[CLIENTS[client].env];
      assert(binary?.startsWith("/"), `Missing pinned ${CLIENTS[client].env}`);
      nodes.push(await startPrivateClient(client, binary!, genesis, i, true));
      const nodeInfo = await nodes[i]!.rpc<NodeInfo>("admin_nodeInfo");
      info.push(nodeInfo);
      const actualGenesis = await nodes[i]!.rpc<Block>("eth_getBlockByNumber", [
        "0x0",
        false,
      ]);
      if (genesisHash) assert.equal(actualGenesis.hash, genesisHash);
      else genesisHash = actualGenesis.hash;
      assert.equal(await nodes[i]!.rpc("eth_chainId"), "0x539");
      assert.equal(
        BigInt(
          await nodes[i]!.rpc<Hex>("eth_getBalance", [
            session.address,
            "latest",
          ]),
        ),
        allocation,
      );
      assert.equal(
        await nodes[i]!.rpc("eth_getCode", [session.address, "latest"]),
        "0x",
      );
      assert.equal(
        await nodes[i]!.rpc("eth_getTransactionCount", [
          session.address,
          "latest",
        ]),
        "0x0",
      );
    }
    assert.equal(new Set(info.map((node) => node.id)).size, nodes.length);
    // Bring every node to the same normal post-Merge head before requesting peers.
    step = "initial agreed head";
    await build();
    step = "static peer handshake";
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        // Same triangle, two existing loopback interfaces: Nethermind's default
        // recent-IP filter rejects two peers from the same source IP. Preserve
        // that filter: B dials A on ::1, A dials C on 127.0.0.1. No public bind.
        const from = nodes[i]!.client === "nethermind" && j === 1 ? j : i;
        const to = from === j ? i : j;
        const host = nodes[to]!.client === "nethermind" ? "[::1]" : "127.0.0.1";
        const enode = `${info[to]!.enode.split("@")[0]}@${host}:${18649 + to * 10}`;
        await nodes[from]!.rpc("admin_addPeer", [enode]);
      }
    for (let poll = 0; poll < 150; poll++) {
      const counts = await Promise.all(
        nodes.map((node) => node.rpc<Hex>("net_peerCount")),
      );
      if (counts.every((count) => Number(BigInt(count)) === nodes.length - 1))
        break;
      if (poll === 149)
        throw new Error(`Incomplete peer handshake: ${counts.join(",")}`);
      await delay(100);
    }
    peers = await Promise.all(
      nodes.map(async (node, i) => {
        const connected = await node.rpc<{ id: string }[]>("admin_peers");
        assert.deepEqual(
          connected.map((peer) => peer.id).sort(),
          info
            .filter((_, other) => other !== i)
            .map((peer) => peer.id)
            .sort(),
          "Only the expected private fixture identities may be connected",
        );
        const syncing = await node.rpc("eth_syncing");
        assert.equal(syncing, false);
        return { node: name(i), peers: connected, syncing };
      }),
    );
    step = "ordinary control P2P";
    const controlRaw = await control.signTransaction({
      type: "eip1559",
      chainId: 1337,
      nonce: 0,
      to: recipient,
      value: 0n,
      data: "0x",
      gas: 21000n,
      ...fees,
    });
    const controlSend = await submit(0, "control", controlRaw);
    for (let i = 0; i < nodes.length; i++)
      await observe(i, controlSend.hash, "control");
    const controlBlock = await build();
    assert(controlBlock.transactions.includes(controlSend.hash));
    stage = "media";
    for (let sequence = 0; sequence < 4; sequence++) {
      step = `media ${sequence}`;
      const payload = Uint8Array.from(
        { length: 6000 },
        (_, i) => (i * 31 + sequence) % 256,
      );
      const data = bytesToHex(
        encodePatioPacket({
          version: 1,
          type: sequence ? PatioPacketType.AUDIO : PatioPacketType.START,
          codec: PatioCodec.OPUS_WEBM,
          flags: 0,
          streamId,
          windowIndex: 0,
          sequence,
          capturedAtMs: BigInt(sequence * 3000),
          payload,
        }),
      );
      const raw = await session.signTransaction({
        type: "eip1559",
        chainId: 1337,
        nonce: 1,
        to: recipient,
        value: 0n,
        data,
        gas: 300000n,
        maxFeePerGas: BigInt(sequence + 1) * 2_000_000_000n,
        maxPriorityFeePerGas: BigInt(sequence + 1) * 1_000_000_000n,
      });
      const hash = keccak256(raw);
      media.push({ raw, hash, sequence, data });
      await submit(0, "media", raw);
      for (let i = 0; i < nodes.length; i++) {
        await observe(i, hash, "media", sequence);
        assert.equal(
          (await pool(i)).filter(
            (tx) => tx.from.toLowerCase() === session.address.toLowerCase(),
          ).length,
          1,
        );
        assert.equal(
          await nodes[i]!.rpc("eth_getTransactionCount", [
            session.address,
            "latest",
          ]),
          "0x0",
        );
      }
    }
    stage = "close";
    step = "freeze and construct complete close";
    const candidate = buildRetirementCandidate({
      session: session.address,
      chainId: 1337,
      gap: 0,
      highestMediaNonce: 1,
      code: "0x",
      balance: allocation,
      ...fees,
      inventory: {
        freshExclusiveLocalKey: true,
        frozen: true,
        ordinaryNonces: [],
        authorityNonces: [],
        mediaNonces: media.map(() => 1),
      },
    });
    const authorizationList = await Promise.all(
      candidate.authorizationRequests.map((request) =>
        session.signAuthorization(request),
      ),
    );
    await validateRetirementSignatures(candidate, authorizationList);
    const {
      authorizationRequests: _requests,
      expectedNonce,
      sweepReserve: _reserve,
      ...transaction
    } = candidate;
    const closeRaw = await session.signTransaction({
      ...transaction,
      authorizationList,
    });
    const decodedClose = parseTransaction(closeRaw);
    assert.equal(decodedClose.type, "eip7702");
    assert.equal(decodedClose.nonce, 0);
    assert.deepEqual(decodedClose.authorizationList, authorizationList);
    step = "close RPC admission and P2P";
    const closeSend = await submit(closeEntry, "close", closeRaw);
    await observe(closeEntry, closeSend.hash, "close");
    await observe(receiver, closeSend.hash, "close");
    // Mixed A may reject the P2P close. Record pool choice separately from block import.
    if (topology !== "geth-geth")
      observations.push({
        node: "A",
        role: "close",
        hash: closeSend.hash,
        atMs: performance.now() - origin,
        present: (await pool(0)).some((tx) => tx.hash === closeSend.hash),
        via: "read-only pool check; no RPC submission to A",
      });
    stage = "inclusion";
    step = "receiver normal payload selection";
    const closeBlock = await build();
    assert(
      closeBlock.transactions.includes(closeSend.hash),
      "Close received but not selected",
    );
    stage = "safety";
    step = "canonical retirement on all nodes";
    for (const node of nodes) {
      assert.equal(
        Number(
          BigInt(
            await node.rpc<Hex>("eth_getTransactionCount", [
              session.address,
              "latest",
            ]),
          ),
        ),
        expectedNonce,
      );
      assert.equal(
        await node.rpc("eth_getCode", [session.address, "latest"]),
        "0x",
      );
      for (const tx of media)
        assert.equal(
          await node.readReceipt(tx.hash),
          null,
          "SAFETY FAILURE: media has canonical receipt",
        );
    }
    const closeReceipt = await nodes[receiver]!.readReceipt(closeSend.hash);
    assert.equal(closeReceipt?.status, "0x1");
    assert(closeReceipt);
    const closeCost =
      BigInt(closeReceipt.gasUsed) * BigInt(closeReceipt.effectiveGasPrice);
    const afterClose = BigInt(
      await nodes[receiver]!.rpc<Hex>("eth_getBalance", [
        session.address,
        "latest",
      ]),
    );
    assert.equal(afterClose, allocation - closeCost);
    // Every old signed transaction has nonce 1 < canonical 2. Do not resend to receiver.
    assert(
      media.every(
        (tx) => parseTransaction(tx.raw).nonce === 1 && 1 < expectedNonce,
      ),
    );
    stage = "sweep";
    step = "post-retirement local return";
    const value = afterClose - 21000n * fees.maxFeePerGas;
    const sweepRaw = await session.signTransaction({
      type: "eip1559",
      chainId: 1337,
      nonce: expectedNonce,
      to: recipient,
      value,
      data: "0x",
      gas: 21000n,
      ...fees,
    });
    const sweepSend = await submit(closeEntry, "sweep", sweepRaw);
    await observe(closeEntry, sweepSend.hash, "sweep");
    await observe(receiver, sweepSend.hash, "sweep");
    const sweepBlock = await build();
    assert(sweepBlock.transactions.includes(sweepSend.hash));
    const sweepReceipt = await nodes[receiver]!.readReceipt(sweepSend.hash);
    assert.equal(sweepReceipt?.status, "0x1");
    assert(sweepReceipt);
    const sweepCost =
      BigInt(sweepReceipt.gasUsed) * BigInt(sweepReceipt.effectiveGasPrice);
    const remaining = BigInt(
      await nodes[receiver]!.rpc<Hex>("eth_getBalance", [
        session.address,
        "latest",
      ]),
    );
    assert.equal(remaining, allocation - closeCost - value - sweepCost);
    assert.equal(
      BigInt(
        await nodes[receiver]!.rpc<Hex>("eth_getBalance", [
          recipient,
          "latest",
        ]),
      ),
      value,
    );
    for (const node of nodes) {
      assert.equal(
        await node.rpc("eth_getTransactionCount", [session.address, "latest"]),
        "0x3",
      );
      for (const tx of media)
        assert.equal(await node.readReceipt(tx.hash), null);
    }
    outcome = {
      status: "PASS",
      nonceAfterClose: expectedNonce,
      finalNonce: 3,
      code: "0x",
      mediaIncluded: 0,
      closeReceipt,
      sweepReceipt,
      initialBalance: allocation,
      closeCost,
      sweepCost,
      returnedValue: value,
      remaining,
      oldMediaInvalidReason:
        "Every signed media nonce 1 is below canonical nonce 2 after retirement",
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("SAFETY FAILURE:"))
      stage = "safety";
    outcome = {
      status: "FAIL",
      stage,
      step,
      error: error instanceof Error ? error.message : "unknown failure",
    };
  } finally {
    // Keep bounded failure evidence, without calldata, raw transactions or keys.
    for (let i = 0; i < nodes.length; i++) {
      try {
        observations.push({
          node: name(i),
          role: "final snapshot",
          pool: (await pool(i)).map(({ hash, nonce, type }) => ({
            hash,
            nonce,
            type,
          })),
          nonce: await nodes[i]!.rpc("eth_getTransactionCount", [
            session.address,
            "latest",
          ]),
        });
      } catch {
        /* Preserve original failure. */
      }
    }
    await Promise.all(nodes.map((node) => node.stop()));
  }
  return {
    topology,
    repetition,
    chainId: 1337,
    fork: "Prague",
    genesisHash,
    config: genesis.config,
    session: session.address,
    controlAccount: control.address,
    streamId,
    timeoutMs,
    elapsedMs: performance.now() - origin,
    nodes: nodes.map((node, i) => ({
      name: name(i),
      client: node.client,
      version: CLIENTS[node.client],
      directory: node.directory,
      identity: info[i]?.id,
      enode: info[i]?.enode,
    })),
    peers,
    sends,
    observations,
    blocks,
    outcome,
  };
}

async function main() {
  type Result = Awaited<ReturnType<typeof trial>>;
  const prior = process.env.PATIO_H24_INFRASTRUCTURE_REPORT;
  let results: Result[] = [];
  if (prior) {
    // Bounded harness-only restarts are permitted before any mixed sends.
    // Preserve all original observations, including the failed primary path.
    const previous = JSON.parse(readFileSync(prior, "utf8")) as {
      results: Result[];
    };
    assert(previous.results.length >= 2 && previous.results.length <= 5);
    const [primary, ...mixedAttempts] = previous.results;
    assert.equal(primary!.topology, "geth-geth");
    assert.equal((primary!.outcome as { stage: string }).stage, "media");
    for (const mixed of mixedAttempts) {
      assert.equal(mixed.topology, "nethermind-geth-geth");
      assert.equal(
        (mixed.outcome as { stage: string }).stage,
        "infrastructure",
      );
      assert.equal(mixed.sends.length, 0);
    }
    results = previous.results;
  }
  let topology: Topology = "geth-geth";
  const first = prior ? results[0]! : await trial(topology, 1);
  if (!prior) results.push(first);
  const status = first.outcome as { status: string; stage?: Stage };
  if (
    status.status === "FAIL" &&
    (status.stage === "media" || status.stage === "close")
  ) {
    topology = "nethermind-geth-geth";
    results.push(await trial(topology, 1));
  }
  const last = results.at(-1)!.outcome as { status: string };
  if (last.status === "PASS")
    for (let repetition = 2; repetition <= 3; repetition++)
      results.push(await trial(topology, repetition));
  console.log(
    JSON.stringify(
      { publicNetwork: "NOT RUN", results },
      (_, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      2,
    ),
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

/** Owned H2.6 private nodes + bounded browser bridge. No production imports. */
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress, keccak256, parseTransaction, type Hex } from "viem";
import { packetFromHex } from "@patio/protocol";
import { flattenTxpoolTransactions } from "../../lib/direct-hoodi";
import { PrivateRetirementEnvironment } from "../../lib/private-retirement-environment";
import { quoteSingleNonce } from "../../lib/single-nonce-plan";
import { audioPlanKey } from "../../lib/private-audio-preparation";
import { compactFixtureSnapshot } from "./full-app-metadata";
import { monitorPrivatePeers } from "./peer-readiness";
import type {
  SingleNonceTransport,
  RetirementEvent,
} from "../../lib/single-nonce-transport";
import {
  CLIENTS,
  fixtureGenesis,
  startPrivateClient,
  type PrivateClient,
  type Block,
} from "./private-client";

type Snapshot = ReturnType<SingleNonceTransport["snapshot"]>;
const nodes: PrivateClient[] = [];
// Owned launcher settings only; attestation still verifies chain/genesis/peers.
const rpcBase = Number(process.env.PATIO_PRIVATE_RPC_BASE ?? 18647);
const bridgePort = Number(process.env.PATIO_PRIVATE_BRIDGE_PORT ?? 18780);
const appOrigin =
  process.env.PATIO_PRIVATE_APP_ORIGIN ?? "http://127.0.0.1:3106";
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(appOrigin));
assert(
  [rpcBase, bridgePort].every(
    (p) => Number.isInteger(p) && p > 1024 && p < 65000,
  ),
);
let peerReadiness: ReturnType<typeof monitorPrivatePeers> | undefined;
const operator = privateKeyToAccount(generatePrivateKey());
const genesis = fixtureGenesis({ [operator.address]: 10n ** 18n });
const origin = performance.now();
const proof = {
  chainId: 1337,
  fork: "Prague",
  publicNetwork: "NOT RUN",
  clients: CLIENTS,
  genesisHash: "",
  identities: [] as string[],
  defaultRefused: false,
  funding: undefined as undefined | { hash: Hex; value: string },
  observations: [] as unknown[],
  sends: [] as {
    node: string;
    hash: Hex;
    nonce: number;
    type: string;
    atMs: number;
  }[],
  blocks: [] as { hash: Hex; number: Hex; transactions: Hex[] }[],
  events: [] as RetirementEvent[],
  snapshot: undefined as Snapshot | undefined,
  final: undefined as unknown,
  failure: undefined as string | undefined,
};
const report = process.env.PATIO_H26_REPORT;
assert(report?.startsWith("/"), "Explicit local metadata report path required");
const save = () => writeFileSync(report!, JSON.stringify(proof, null, 2));
let prepared: Snapshot | undefined;
let fundingAttempted = false;
let reviewedPlan: ReturnType<typeof quoteSingleNonce> | undefined;
const fundingGas = 21000n;
const fundingFeeCap = 3_000_000_000n;
let building = false;
let server: ReturnType<typeof createServer> | undefined;
process.on("SIGTERM", () => {
  if (
    process.env.PATIO_PRIVATE_MANUAL_DEMO === "1" &&
    fundingAttempted &&
    proof.snapshot?.state !== "complete"
  ) {
    console.error(
      "Stop refused: preserve this session. Finish in Patio and save its proof first.",
    );
    return;
  }
  peerReadiness?.stop();
  server?.close();
  void Promise.all(nodes.map((n) => n.stop())).then(() => process.exit(0));
});
const observed = new Set<string>();
async function pool(i: number) {
  return flattenTxpoolTransactions(await nodes[i]!.rpc("txpool_content"));
}
async function observe(i: number, hash: Hex) {
  for (let n = 0; n < 150; n++) {
    const tx = (await pool(i)).find((t) => t.hash === hash);
    if (tx) {
      recordPool(i, [tx]);
      return;
    }
    await delay(100);
  }
  throw new Error(`Exact hash absent from ${"ABC"[i]} pool`);
}
function recordPool(
  i: number,
  txs: ReturnType<typeof flattenTxpoolTransactions>,
) {
  for (const tx of txs) {
    const key = `${i}:${tx.hash}`;
    if (observed.has(key)) continue;
    observed.add(key);
    let packet;
    if (tx.input && tx.input !== "0x") {
      try {
        const p = packetFromHex(tx.input);
        packet = {
          sequence: p.sequence,
          streamId: p.streamId,
          bytes: p.payload.length,
          transportBytes: (tx.input.length - 2) / 2,
        };
      } catch {
        /* not media */
      }
    }
    proof.observations.push({
      node: "ABC"[i],
      hash: tx.hash,
      nonce: tx.nonce,
      packet,
      atMs: performance.now() - origin,
    });
  }
}
async function build(hash?: Hex) {
  assert(!building);
  building = true;
  try {
    const block = await nodes[2]!.buildBlock(nodes.slice(0, 2));
    proof.blocks.push(block);
    const media = proof.sends.filter(
      (s) => s.type === "eip1559" && s.nonce === 1 && s.node === "A",
    );
    assert(
      media.every((m) => !block.transactions.includes(m.hash)),
      "SAFETY INVARIANT FAILED: media included",
    );
    if (hash)
      assert(
        block.transactions.includes(hash),
        "Normal builder did not select expected transaction",
      );
    save();
  } finally {
    building = false;
  }
}
async function reconcile(snapshot: Snapshot) {
  const address = snapshot.descriptor.sessionAddress;
  const receipts = await Promise.all(
    snapshot.signatures.map(async (s) => ({
      hash: s.hash,
      role: s.role,
      receipt: await nodes[2]!.readReceipt(s.hash),
    })),
  );
  for (const row of receipts)
    if (row.role === "media")
      assert.equal(row.receipt, null, "SAFETY INVARIANT FAILED: media receipt");
  const [nonce, code, balance] = await Promise.all([
    nodes[2]!.rpc("eth_getTransactionCount", [address, "latest"]),
    nodes[2]!.rpc("eth_getCode", [address, "latest"]),
    nodes[2]!.rpc<Hex>("eth_getBalance", [address, "latest"]),
  ]);
  const sweep = snapshot.sweepHash
    ? await nodes[2]!.rpc<{ value: Hex; to: Hex }>("eth_getTransactionByHash", [
        snapshot.sweepHash,
      ])
    : null;
  proof.final = {
    nonce,
    code,
    balance,
    receipts,
    sweepValue: sweep?.value,
    returnAddress: sweep?.to,
    operator: operator.address,
  };
  proof.snapshot = compactFixtureSnapshot(snapshot);
  save();
}
async function main() {
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
      rpcBase,
    );
    nodes.push(node);
    infos.push(await node.rpc("admin_nodeInfo"));
    const b = await node.rpc<Block>("eth_getBlockByNumber", ["0x0", false]);
    if (proof.genesisHash) assert.equal(b.hash, proof.genesisHash);
    proof.genesisHash = b.hash;
  }
  await build();
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const from = i === 0 && j === 1 ? 1 : i;
      const to = from === j ? i : j;
      await nodes[from]!.rpc("admin_addPeer", [
        `${infos[to]!.enode.split("@")[0]}@${to === 0 ? "[::1]" : "127.0.0.1"}:${rpcBase + 2 + to * 10}`,
      ]);
    }
  for (let n = 0; n < 150; n++) {
    if (
      (
        await Promise.all(nodes.map((node) => node.rpc<Hex>("net_peerCount")))
      ).every((v) => BigInt(v) === 2n)
    )
      break;
    assert(n < 149, "Private handshake incomplete");
    await delay(100);
  }
  proof.identities = infos.map((i) => i.id);
  // Retain H2.6 registration, but do not assume this promotes an existing
  // inbound peer to static. H2.6.1 restores normal capacity above and verifies
  // durable connections below; filters and peer review remain unchanged.
  await nodes[0]!.rpc("admin_addPeer", [
    `${infos[1]!.enode.split("@")[0]}@127.0.0.1:${rpcBase + 12}`,
  ]);
  const manifest = {
    kind: "patio-owned-prague-fixture" as const,
    chainId: 1337 as const,
    genesisHash: proof.genesisHash as Hex,
    nodeIds: proof.identities as [string, string, string],
  };
  await PrivateRetirementEnvironment.attest(
    manifest,
    nodes.map((node) => ({
      request: <T>(method: string, params: readonly unknown[] = []) =>
        node.rpc<T>(method, [...params]),
    })) as unknown as Parameters<typeof PrivateRetirementEnvironment.attest>[1],
  );
  peerReadiness = monitorPrivatePeers(manifest, nodes);
  await peerReadiness.waitReady();
  const reads = new Set([
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getTransactionCount",
    "eth_getBalance",
    "eth_getCode",
    "eth_maxPriorityFeePerGas",
    "web3_clientVersion",
    "admin_nodeInfo",
    "admin_peers",
    "eth_syncing",
    "txpool_content",
  ]);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", appOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "OPTIONS") {
      res.end();
      return;
    }
    try {
      assert(
        req.headers.origin === appOrigin ||
          (req.method === "GET" && !req.headers.origin),
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        assert(Buffer.isBuffer(chunk));
        size += chunk.length;
        assert(size <= 100000);
        chunks.push(chunk);
      }
      const body: unknown = size
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      let result: unknown = null;
      if (req.url === "/health") {
        let reason: string | undefined;
        try {
          await peerReadiness!.requireReady();
        } catch (error) {
          reason =
            error instanceof Error
              ? error.message
              : "Private topology unavailable";
        }
        result = {
          ready: !reason,
          reason,
          prepared: Boolean(prepared),
          fundingAttempted,
          complete: proof.snapshot?.state === "complete",
          sends: proof.sends.length,
        };
      } else if (req.url === "/manifest") {
        await peerReadiness!.requireReady();
        result = {
          manifest,
          operator: operator.address,
          fundingFeeCapWei: String(fundingGas * fundingFeeCap),
        };
      } else if (req.url === "/descriptor") {
        assert(prepared);
        result = prepared.descriptor;
      } else if (req.url === "/proof") result = proof;
      else if (req.url?.startsWith("/rpc/")) {
        assert(body && typeof body === "object");
        const { method, params } = body as { method: unknown; params: unknown };
        assert(typeof method === "string" && Array.isArray(params));
        const i = Number(req.url.slice(5));
        assert([0, 1, 2].includes(i));
        assert(
          reads.has(method) || (i !== 2 && method === "eth_sendRawTransaction"),
        );
        if (method === "eth_sendRawTransaction") {
          assert(prepared && fundingAttempted);
          const raw: unknown = params[0];
          assert(typeof raw === "string" && /^0x[0-9a-f]+$/i.test(raw));
          const tx = parseTransaction(raw as Hex);
          assert.equal(tx.chainId, 1337);
          assert.equal(
            tx.to?.toLowerCase(),
            tx.nonce === 2
              ? operator.address.toLowerCase()
              : prepared.descriptor.sessionAddress.toLowerCase(),
          );
          assert(
            (i === 0 && tx.type === "eip1559" && tx.nonce === 1) ||
              (i === 1 &&
                ((tx.type === "eip7702" && tx.nonce === 0) ||
                  (tx.type === "eip1559" && tx.nonce === 2))),
          );
          proof.sends.push({
            node: "ABC"[i]!,
            hash: keccak256(raw as Hex),
            nonce: tx.nonce,
            type: tx.type,
            atMs: performance.now() - origin,
          });
        }
        result = await nodes[i]!.rpc(method, params as unknown[]);
        if (method === "txpool_content")
          recordPool(i, flattenTxpoolTransactions(result));
      } else if (req.url === "/baseline") {
        proof.defaultRefused =
          (body as { defaultRefused?: unknown }).defaultRefused === true;
        save();
      } else if (req.url === "/review") {
        await peerReadiness!.requireReady();
        assert(!prepared && !fundingAttempted);
        const { budget, planKey } = body as { budget: string; planKey: string };
        assert(typeof budget === "string" && /^\d+$/.test(budget));
        assert(BigInt(budget) <= 5_000_000_000_000_000n);
        const block = await nodes[1]!.rpc<{ baseFeePerGas: Hex }>(
          "eth_getBlockByNumber",
          ["latest", false],
        );
        const tip = await nodes[1]!.rpc<Hex>("eth_maxPriorityFeePerGas");
        const quote = quoteSingleNonce({
          baseFee: BigInt(block.baseFeePerGas),
          priorityFee: BigInt(tip),
          candidates: 4,
          budget: BigInt(budget),
        });
        assert(
          quote.allowed && audioPlanKey(quote) === planKey,
          "Reviewed private plan changed",
        );
        reviewedPlan = quote;
      } else if (req.url === "/prepared") {
        await peerReadiness!.requireReady();
        assert(
          !prepared &&
            (process.env.PATIO_PRIVATE_MANUAL_DEMO === "1"
              ? reviewedPlan
              : proof.defaultRefused),
        );
        prepared = compactFixtureSnapshot(body as Snapshot);
        assert.equal(prepared.plan.capacity, 4);
        assert.equal(prepared.mode, "single-nonce-retirement-v1");
        assert.equal(prepared.g, 0);
        assert.equal(prepared.signatures.length, 0);
        if (reviewedPlan)
          assert.equal(
            prepared.plan.requiredExposure,
            String(reviewedPlan.requiredExposure),
          );
      } else if (req.url === "/fund") {
        const { address, value } = body as { address: unknown; value: unknown };
        assert(
          prepared &&
            !fundingAttempted &&
            typeof address === "string" &&
            isAddress(address),
        );
        assert(typeof value === "string" && /^\d+$/.test(value));
        assert.equal(address, prepared.descriptor.sessionAddress);
        const block = await nodes[1]!.rpc<{ baseFeePerGas: Hex }>(
          "eth_getBlockByNumber",
          ["latest", false],
        );
        const tip = await nodes[1]!.rpc<Hex>("eth_maxPriorityFeePerGas");
        const quote = quoteSingleNonce({
          baseFee: BigInt(block.baseFeePerGas),
          priorityFee: BigInt(tip),
          candidates: 4,
          ...(reviewedPlan ? { budget: reviewedPlan.budget } : {}),
        });
        if (reviewedPlan)
          assert.equal(
            audioPlanKey(quote),
            audioPlanKey(reviewedPlan),
            "Reviewed private plan changed before funding",
          );
        assert.equal(BigInt(value), quote.requiredExposure);
        assert(quote.requiredExposure <= 5_000_000_000_000_000n);
        // Last read-only boundary before any fixture funding signature/send.
        await peerReadiness!.requireReady();
        fundingAttempted = true;
        const raw = await operator.signTransaction({
          type: "eip1559",
          chainId: 1337,
          nonce: 0,
          to: address,
          value: BigInt(value),
          gas: fundingGas,
          maxFeePerGas: fundingFeeCap,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        const hash = keccak256(raw);
        assert.equal(
          await nodes[0]!.rpc("eth_sendRawTransaction", [raw]),
          hash,
        );
        proof.funding = { hash, value };
        await observe(2, hash);
        await build(hash);
      } else if (req.url === "/event") {
        const e = body as RetirementEvent;
        proof.events.push(
          JSON.parse(
            JSON.stringify({
              stage: e.stage,
              role: e.role,
              hash: e.hash,
              nonce: e.nonce,
              sequence: e.sequence,
              bytes: e.bytes,
              outcome: e.outcome,
              atMonotonicMs: e.atMonotonicMs,
            }),
          ) as RetirementEvent,
        );
        assert(proof.events.length <= 128);
        if (
          (e.stage === "observed" && e.role === "retirement-close") ||
          (e.stage === "rpc-response" &&
            e.role === "sweep" &&
            e.outcome === "hash-returned-not-inclusion")
        ) {
          assert(e.hash);
          await observe(2, e.hash);
          await delay(1500);
          await build(e.hash);
        }
        save();
      } else if (req.url === "/snapshot") await reconcile(body as Snapshot);
      else throw new Error("Unknown fixture endpoint");
      res.end(JSON.stringify(result));
    } catch (error) {
      proof.failure =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "Fixture failure";
      save();
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: /^(A|B|C)(:|↔)|^Private (topology|peer)/.test(proof.failure)
            ? proof.failure
            : "Private fixture rejected request; inspect allowlisted proof",
        }),
      );
    }
  };
  server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(bridgePort, "127.0.0.1", resolve);
  });
  save();
  console.log("PRIVATE H2.6 TOPOLOGY ATTESTED; bridge ready");
}
main().catch(async (error) => {
  peerReadiness?.stop();
  proof.failure = String(error);
  save();
  await Promise.all(nodes.map((n) => n.stop()));
  process.exitCode = 1;
});

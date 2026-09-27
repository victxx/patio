/** R1 private experiment. Run with Node24/tsx; no public URLs, no production caller. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { packetToHex } from "@patio/protocol";
import { keccak256, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildRetirementCandidate,
  validateRetirementSignatures,
} from "../../lib/retirement-candidate";
import { quoteSingleNonce } from "../../lib/single-nonce-plan";
import { RetirementInventory } from "../../lib/single-nonce-state";
import {
  fixtureGenesis,
  startPrivateClient,
  CLIENTS,
  type PrivateClient,
} from "../nonce-retirement/private-client";
import { HashReceiver, deliverHint, type Context, type Hint } from "./receiver";

const binary = process.env.PATIO_R1_RETH;
assert(binary, "Explicit official Reth binary required");
const output = process.env.PATIO_R1_REPORT;
assert(output, "Explicit local report path required");
const report: Record<string, unknown> = {
  schema: 1,
  experiment: "R1",
  startedAt: new Date().toISOString(),
  clients: CLIENTS,
  chainId: 1337,
  fork: "Prague",
  publicTransactions: 0,
  runs: [],
};
const save = () =>
  writeFileSync(
    output,
    JSON.stringify(
      report,
      (_, v: unknown) => (typeof v === "bigint" ? String(v) : v),
      2,
    ),
  );
async function bounded<T>(
  read: () => Promise<T>,
  match: (v: T) => boolean,
  count = 30,
) {
  for (let i = 0; i < count; i++) {
    const value = await read();
    if (match(value)) return value;
    await delay(200);
  }
  return null;
}
async function subscription(node: PrivateClient) {
  const socket = new WebSocket(`ws://127.0.0.1:${node.wsPort}`);
  const events: { hash: Hex; atMs: number }[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WS failed"));
    setTimeout(() => reject(new Error("WS timeout")), 3000).unref();
  });
  let subscribed = false;
  socket.onmessage = (e) => {
    const data = JSON.parse(String(e.data)) as {
      id?: number;
      result?: unknown;
      params?: { result: Hex };
    };
    if (data.id === 1 && typeof data.result === "string") subscribed = true;
    if (data.params && events.length < 32)
      events.push({ hash: data.params.result, atMs: performance.now() });
  };
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: ["newPendingTransactions"],
    }),
  );
  assert(await bounded(() => Promise.resolve(subscribed), Boolean));
  return { events, close: () => socket.close() };
}
async function run(auxiliary: boolean, timing: boolean) {
  const result: Record<string, unknown> = {
    topology: auxiliary
      ? "Nethermind media -> Reth S + Reth R; close S -> R"
      : "Reth S -> Reth R",
    scenario: timing ? "timing" : "functional",
    stages: [],
    candidates: [],
  };
  (report.runs as unknown[]).push(result);
  save();
  const session = privateKeyToAccount(generatePrivateKey()),
    control = privateKeyToAccount(generatePrivateKey());
  const balance = 10n ** 18n;
  const genesis = fixtureGenesis({
    [session.address]: balance,
    [control.address]: balance,
  });
  const nodes: PrivateClient[] = [];
  const sockets: Awaited<ReturnType<typeof subscription>>[] = [];
  try {
    const S = await startPrivateClient("reth", binary!, genesis, 40, true);
    nodes.push(S);
    const R = await startPrivateClient("reth", binary!, genesis, 41, true);
    nodes.push(R);
    let A = S;
    if (auxiliary) {
      assert(process.env.PATIO_H23_NETHERMIND);
      A = await startPrivateClient(
        "nethermind",
        process.env.PATIO_H23_NETHERMIND,
        genesis,
        42,
        true,
        "client-default",
      );
      nodes.push(A);
    }
    const infos = await Promise.all(
      nodes.map((n) => n.rpc<{ id: string; enode: string }>("admin_nodeInfo")),
    );
    assert.equal(new Set(infos.map((i) => i.id)).size, nodes.length);
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        // Preserve H2.4's IPv4/IPv6 split, not client filter overrides.
        const from = auxiliary && i === 1 && j === 2 ? j : i;
        const to = from === j ? i : j;
        const host = nodes[to]!.client === "nethermind" ? "[::1]" : "127.0.0.1";
        await nodes[from]!.rpc("admin_addPeer", [
          `${infos[to]!.enode.split("@")[0]}@${host}:${18649 + (40 + to) * 10}`,
        ]);
      }
    for (const n of nodes)
      assert(
        await bounded(
          () => n.rpc<{ id: string }[]>("admin_peers"),
          (peers) => peers.length === nodes.length - 1,
        ),
      );
    const hashes = await Promise.all(
      nodes.map((n) =>
        n.rpc<{ hash: Hex }>("eth_getBlockByNumber", ["0x0", false]),
      ),
    );
    assert.equal(new Set(hashes.map((h) => h.hash)).size, 1);
    result.environment = {
      genesis: hashes[0]!.hash,
      nodes: await Promise.all(
        nodes.map(async (n, i) => ({
          role: i === 0 ? "S" : i === 1 ? "R" : "A",
          client: await n.rpc("web3_clientVersion"),
          id: infos[i]!.id,
          peers: (await n.rpc<{ id: string }[]>("admin_peers")).map(
            (p) => p.id,
          ),
          chainId: await n.rpc("eth_chainId"),
        })),
      ),
    };
    await R.buildBlock(nodes.filter((n) => n !== R)); // normal forkchoice activates synced gossip
    for (const n of [S, R]) sockets.push(await subscription(n));
    const controlRaw = await control.signTransaction({
      type: "eip1559",
      chainId: 1337,
      nonce: 0,
      to: zeroAddress,
      value: 1n,
      gas: 21000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const controlHash = keccak256(controlRaw);
    assert.equal(
      await A.rpc("eth_sendRawTransaction", [controlRaw]),
      controlHash,
    );
    assert(
      await bounded(
        () => R.rpc("eth_getTransactionByHash", [controlHash]),
        Boolean,
      ),
      "Ordinary control did not propagate",
    );
    result.control = { hash: controlHash, propagated: true };
    await R.buildBlock(nodes.filter((n) => n !== R));
    const context: Context = {
      chainId: 1337,
      sessionAddress: session.address,
      streamId: "0x11112222333344445555666677778888",
      nonce: 1,
      capacity: 4,
    };
    const read = (node: PrivateClient) => (hash: Hex, signal: AbortSignal) => {
      signal.throwIfAborted();
      return node.rpc("eth_getTransactionByHash", [hash], false, signal);
    };
    const immediate = new HashReceiver(context, read(R), timing ? 8 : 12, 200);
    const delayed = new HashReceiver(context, read(R), 8, 200);
    const inventory = new RetirementInventory(0, 4);
    inventory.transition("broadcasting");
    const plan = quoteSingleNonce({
      baseFee: 1_000_000_000n,
      priorityFee: 1_000_000_000n,
      candidates: 4,
      budget: 5_000_000_000_000_000n,
    });
    assert(plan.allowed);
    result.plan = {
      mediaFees: plan.mediaFees,
      mediaTips: plan.mediaTips,
      requiredExposure: plan.requiredExposure,
      cadenceMs: 3000,
      listenerAcknowledgementsGateTiming: false,
    };
    const media: Hex[] = [],
      jobs: Promise<unknown>[] = [];
    const t0 = performance.now();
    for (let index = 0; index < 4; index++) {
      if (timing)
        await delay(Math.max(0, t0 + index * 3000 - performance.now()));
      inventory.assertIntent("media", 1, index);
      const data = packetToHex({
        version: 1,
        type: 2,
        codec: 1,
        flags: 0,
        streamId: context.streamId,
        windowIndex: 0,
        sequence: index,
        capturedAtMs: BigInt(index * 3000),
        payload: new Uint8Array(6000).fill(65 + index),
      });
      const raw = await session.signTransaction({
        type: "eip1559",
        chainId: 1337,
        nonce: 1,
        to: session.address,
        value: 0n,
        data,
        gas: plan.mediaGas,
        maxFeePerGas: plan.mediaFees[index]!,
        maxPriorityFeePerGas: plan.mediaTips[index]!,
      });
      const hash = keccak256(raw);
      media.push(hash);
      inventory.record({
        role: "media",
        nonce: 1,
        index,
        hash,
        maxFee: String(plan.mediaFees[index]),
        tip: String(plan.mediaTips[index]),
      });
      const hint: Hint = {
        version: 1,
        chainId: 1337,
        sessionAddress: session.address,
        streamId: context.streamId,
        sequence: index,
        transactionHash: hash,
      };
      assert.equal(await R.rpc("eth_getTransactionByHash", [hash]), null);
      const start = performance.now();
      const returned = await A.rpc("eth_sendRawTransaction", [raw]);
      assert.equal(returned, hash);
      assert(
        await A.rpc("eth_getTransactionByHash", [hash]),
        "Ingress response is not proof without exact lookup",
      );
      const candidate: Record<string, unknown> = {
        hash,
        nonce: 1,
        type: 2,
        sequence: index,
        replacementIndex: index,
        maxFee: plan.mediaFees[index],
        tip: plan.mediaTips[index],
        packetBytes: (data.length - 2) / 2,
        inputDigest: keccak256(data),
        rpcReturnedExactHash: true,
        senderHasExact: true,
        submittedMs: start - t0,
        ingress: auxiliary ? "A" : "S",
        receiver: "R",
        beforeSendNull: true,
      };
      (result.candidates as unknown[]).push(candidate);
      const observe = async () => {
        const v = (await deliverHint(immediate, hint)) as { digest?: Hex };
        if (v.digest) assert.equal(v.digest, keccak256(data));
        candidate.immediate = v;
        candidate.readCompletedMs = performance.now() - t0;
        return v;
      };
      const j = observe();
      jobs.push(j);
      jobs.push(
        delay(3500).then(async () => {
          candidate.delayed = await deliverHint(delayed, hint);
        }),
      );
      if (!timing) await j;
      if (index > 0)
        candidate.previousAfterReplacement = {
          senderAvailable: !!(await A.rpc("eth_getTransactionByHash", [
            media[index - 1],
          ])),
          receiverAvailable: !!(await R.rpc("eth_getTransactionByHash", [
            media[index - 1],
          ])),
        };
      save();
    }
    await Promise.all(jobs);
    inventory.freeze();
    assert.throws(() => inventory.assertIntent("media", 1, 4));
    result.receivers = {
      immediate: immediate.metrics,
      delayed: delayed.metrics,
      delayedHintMs: 3500,
    };
    result.inventory = inventory.snapshot();
    result.poolBeforeClose = await Promise.all(
      nodes.map(async (n) => ({
        client: n.client,
        status: await n.rpc("txpool_status"),
      })),
    );
    if (!auxiliary) {
      const isolated = await startPrivateClient(
        "reth",
        binary!,
        genesis,
        43,
        false,
      );
      nodes.push(isolated);
      try {
        assert.deepEqual(await isolated.rpc("admin_peers"), []);
        result.isolatedHashOnlyControl = {
          peers: 0,
          knownHash: media[3],
          response: await isolated.rpc("eth_getTransactionByHash", [media[3]]),
        };
      } finally {
        await isolated.stop();
        nodes.pop();
      }
    }
    const candidate = buildRetirementCandidate({
      session: session.address,
      chainId: 1337,
      gap: 0,
      highestMediaNonce: 1,
      code: await S.rpc("eth_getCode", [session.address, "latest"]),
      inventory: {
        freshExclusiveLocalKey: true,
        frozen: true,
        ordinaryNonces: [],
        authorityNonces: [],
        mediaNonces: [1],
      },
      maxFeePerGas: plan.closeFee,
      maxPriorityFeePerGas: plan.closeTip,
      balance,
    });
    const authorizationList = await Promise.all(
      candidate.authorizationRequests.map((a) =>
        session.signAuthorization({
          contractAddress: a.address,
          chainId: a.chainId,
          nonce: a.nonce,
        }),
      ),
    );
    await validateRetirementSignatures(candidate, authorizationList);
    inventory.assertIntent("retirement-close", 0);
    const raw = await session.signTransaction({
      type: candidate.type,
      chainId: 1337,
      nonce: 0,
      to: session.address,
      value: 0n,
      data: "0x",
      gas: candidate.gas,
      maxFeePerGas: plan.closeFee,
      maxPriorityFeePerGas: plan.closeTip,
      authorizationList,
    });
    const hash = keccak256(raw);
    result.close = {
      hash,
      ingress: "S",
      before: await S.rpc("eth_getTransactionCount", [
        session.address,
        "latest",
      ]),
    };
    const close = result.close as Record<string, unknown>;
    try {
      close.rpc = await S.rpc("eth_sendRawTransaction", [raw]);
    } catch (e) {
      close.error = String(e);
      result.outcome = "close-admission-blocked";
      return result;
    }
    assert.equal(close.rpc, hash);
    close.senderHasExact = !!(await S.rpc("eth_getTransactionByHash", [hash]));
    close.receiverHasExact = !!(await bounded(
      () => R.rpc("eth_getTransactionByHash", [hash]),
      Boolean,
    ));
    if (!close.receiverHasExact) {
      result.outcome = "close-propagation-blocked";
      return result;
    }
    const block = await R.buildBlock(nodes.filter((n) => n !== R));
    close.block = block;
    assert(
      block.transactions.includes(hash),
      "Normal builder did not select close",
    );
    const receipt = await R.readReceipt(hash);
    assert(receipt && receipt.status === "0x1");
    close.receipt = receipt;
    close.nonce = await R.rpc("eth_getTransactionCount", [
      session.address,
      "latest",
    ]);
    close.code = await R.rpc("eth_getCode", [session.address, "latest"]);
    assert.equal(close.nonce, "0x2");
    assert.equal(close.code, "0x");
    const exclusion = await Promise.all(
      media.map(async (h) => ({
        hash: h,
        receipt: await R.readReceipt(h),
        inCloseBlock: block.transactions.includes(h),
        byHashAfterClose: !!(await R.rpc("eth_getTransactionByHash", [h])),
        nonceStale: true,
      })),
    );
    assert(exclusion.every((e) => e.receipt === null && !e.inCloseBlock));
    result.mediaExclusion = exclusion;
    const remaining = BigInt(
      await R.rpc<Hex>("eth_getBalance", [session.address, "latest"]),
    );
    const value = remaining - plan.sweepReserve;
    assert(value > 0n);
    const sweep = await session.signTransaction({
      type: "eip1559",
      chainId: 1337,
      nonce: 2,
      to: control.address,
      value,
      gas: 21000n,
      maxFeePerGas: plan.closeFee,
      maxPriorityFeePerGas: plan.closeTip,
    });
    const sweepHash = keccak256(sweep);
    assert.equal(await S.rpc("eth_sendRawTransaction", [sweep]), sweepHash);
    assert(
      await bounded(
        () => R.rpc("eth_getTransactionByHash", [sweepHash]),
        Boolean,
      ),
    );
    await R.buildBlock(nodes.filter((n) => n !== R));
    const sweepReceipt = await R.readReceipt(sweepHash);
    assert(sweepReceipt && sweepReceipt.status === "0x1");
    const residual = BigInt(
      await R.rpc<Hex>("eth_getBalance", [session.address, "latest"]),
    );
    const closeCost =
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice),
      sweepCost =
        BigInt(sweepReceipt.gasUsed) * BigInt(sweepReceipt.effectiveGasPrice);
    assert.equal(balance, closeCost + sweepCost + value + residual);
    result.accounting = {
      genesisAllocation: balance,
      closeCost,
      sweepCost,
      returned: value,
      residual,
      sweepReceipt,
      finalNonce: await R.rpc("eth_getTransactionCount", [
        session.address,
        "latest",
      ]),
    };
    result.outcome = immediate.metrics.every(
      (m) => m.outcome === "validated-unincluded",
    )
      ? "complete-local-path"
      : "media-propagation-blocked-close-and-sweep-passed";
    return result;
  } catch (error) {
    result.error = String(error);
    result.outcome = "environment-or-assertion-blocked";
    return result;
  } finally {
    result.subscriptions = sockets.map((s, i) => ({
      node: i === 0 ? "S" : "R",
      events: s.events,
    }));
    sockets.forEach((s) => s.close());
    for (const node of nodes.reverse()) await node.stop();
    save();
  }
}
async function main() {
  await run(false, false);
  await run(false, true);
  if (
    (report.runs as { outcome: string }[]).some(
      (r) => r.outcome === "media-propagation-blocked-close-and-sweep-passed",
    )
  ) {
    await run(true, false);
    await run(true, true);
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify(
      (
        report.runs as {
          topology: string;
          scenario: string;
          outcome: string;
          error?: string;
        }[]
      ).map(({ topology, scenario, outcome, error }) => ({
        topology,
        scenario,
        outcome,
        error,
      })),
    ),
  );
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});

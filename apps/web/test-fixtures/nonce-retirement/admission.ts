/** Only for the separately launched, peerless pinned Geth developer fixture. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXECUTOR_VERSION, LOCAL_CHAIN_ID } from "./candidate";

let id = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch("http://127.0.0.1:18547", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const result = (await response.json()) as {
    result: T;
    error?: { code: number; message: string };
  };
  if (result.error)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.result;
}
interface Receipt {
  status: Hex;
  gasUsed: Hex;
  blockHash: Hex;
  transactionHash: Hex;
}
async function receipt(hash: Hex, required = true): Promise<Receipt | null> {
  for (let i = 0; i < 40; i++) {
    const r = await rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await delay(100);
  }
  if (required)
    throw new Error(
      "Local mining did not include transaction within 4 seconds",
    );
  return null;
}
async function pool(account: Address) {
  const contents = await rpc<
    Record<string, Record<string, { hash: Hex; nonce: Hex }>>
  >("txpool_contentFrom", [account]);
  return Object.fromEntries(
    Object.entries(contents).map(([kind, entries]) => [
      kind,
      Object.values(entries).map((tx) => ({ hash: tx.hash, nonce: tx.nonce })),
    ]),
  );
}
async function main() {
  assert(
    process.env.PATIO_ISOLATED_GETH === "peerless-dev-1.15.6",
    "Explicit isolated fixture launch acknowledgement required",
  );
  const version = await rpc<string>("web3_clientVersion");
  assert(version.includes(EXECUTOR_VERSION));
  assert.equal(await rpc("eth_chainId"), "0x539");
  assert.equal(await rpc("net_peerCount"), "0x0");
  const info = await rpc<{
    protocols: { eth: { config: { chainId: number; pragueTime: number } } };
  }>("admin_nodeInfo");
  assert.equal(info.protocols.eth.config.chainId, LOCAL_CHAIN_ID);
  assert.equal(info.protocols.eth.config.pragueTime, 0);
  const [faucet] = await rpc<Address[]>("eth_accounts");
  assert(
    faucet,
    "Only the local dev preallocation may fund these synthetic accounts",
  );
  const genesis = await rpc<{ hash: Hex }>("eth_getBlockByNumber", [
    "0x0",
    false,
  ]);
  const observations: unknown[] = [];
  const fees = {
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  for (const [name, count, queued, older] of [
    ["no queue / one authority", 1, 0, false],
    ["no queue / four authorities", 4, 0, false],
    ["one queued media nonce", 1, 1, false],
    ["four queued media nonces", 4, 4, false],
    ["older same-nonce media replaced in pool", 1, 1, true],
  ] as const) {
    const account = privateKeyToAccount(generatePrivateKey());
    const fund: Hex = await rpc<Hex>("eth_sendTransaction", [
      { from: faucet, to: account.address, value: "0xde0b6b3a7640000" },
    ]);
    assert.equal((await receipt(fund))?.status, "0x1");
    for (let n = 1; n <= queued; n++) {
      const raw = await account.signTransaction({
        type: "eip1559",
        chainId: LOCAL_CHAIN_ID,
        to: faucet,
        nonce: n,
        value: 0n,
        data: "0x504154494f",
        gas: 30_000n,
        ...fees,
      });
      await rpc("eth_sendRawTransaction", [raw]);
    }
    const retainedBeforeReplacement = await pool(account.address);
    if (older) {
      const raw = await account.signTransaction({
        type: "eip1559",
        chainId: LOCAL_CHAIN_ID,
        to: faucet,
        nonce: 1,
        value: 0n,
        data: "0x504154494f02",
        gas: 30_000n,
        maxFeePerGas: 4_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
      });
      await rpc("eth_sendRawTransaction", [raw]);
    }
    const before = await pool(account.address);
    const authorizations = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        account.signAuthorization({
          address: zeroAddress,
          chainId: LOCAL_CHAIN_ID,
          nonce: i + 1,
        }),
      ),
    );
    const raw = await account.signTransaction({
      type: "eip7702",
      chainId: LOCAL_CHAIN_ID,
      nonce: 0,
      to: account.address,
      value: 0n,
      data: "0x",
      ...fees,
      gas: 21_000n + 25_000n * BigInt(count),
      authorizationList: authorizations,
    });
    let hash: Hex | null = null;
    let error: string | null = null;
    try {
      hash = await rpc<Hex>("eth_sendRawTransaction", [raw]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "unknown";
    }
    const afterAdmission = await pool(account.address);
    const mined = hash ? await receipt(hash, !queued) : null;
    const canonicalNonce = await rpc<Hex>("eth_getTransactionCount", [
      account.address,
      "latest",
    ]);
    const code = await rpc<Hex>("eth_getCode", [account.address, "latest"]);
    assert.equal(code, "0x");
    if (queued) {
      // With local tracking enabled this Geth version hides stateful pool
      // errors from RPC. A returned hash is NOT evidence of pool admission.
      assert.equal(error, null);
      assert.equal(mined, null);
      assert.equal(canonicalNonce, "0x0");
      assert.deepEqual(afterAdmission, before);
    } else {
      assert.equal(error, null);
      assert.equal(mined?.status, "0x1");
      assert.equal(Number(BigInt(canonicalNonce)), count + 1);
    }
    observations.push({
      name,
      retainedBeforeReplacement,
      before,
      afterAdmission,
      error,
      admission: queued
        ? "returned hash; absent from pool and canonical state"
        : "admitted and included",
      hash,
      canonicalNonce,
      code,
      receipt: mined,
      poolAfterBlock: await pool(account.address),
    });
  }
  console.log(
    JSON.stringify(
      {
        version,
        chainId: LOCAL_CHAIN_ID,
        genesis: genesis.hash,
        config: info.protocols.eth.config,
        noPeers: true,
        observations,
      },
      null,
      2,
    ),
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

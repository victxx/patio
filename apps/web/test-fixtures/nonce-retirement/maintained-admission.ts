/** H2.3 admission matrix. Shared process/Engine fixture extended in H2.4. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildRetirementCandidate,
  validateRetirementSignatures,
  LOCAL_CHAIN_ID,
} from "./candidate";
import {
  CLIENTS,
  fixtureGenesis,
  startPrivateClient,
  type Client,
  type Block,
} from "./private-client";
interface PoolTx {
  hash: Hex;
  nonce: Hex;
}
type Pool = Record<string, Record<string, Record<string, PoolTx>>>;
const balance = 1_000_000_000_000_000_000n;
const fees = {
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};
const cases = [
  { name: "A-control", highest: 1, submitted: 0 },
  { name: "B-one-nonce", highest: 1, submitted: 1 },
  { name: "C-replacements", highest: 1, submitted: 4 },
  { name: "D-four-nonces", highest: 4, submitted: 4 },
] as const;

async function runCase(
  client: Client,
  binary: string,
  scenario: (typeof cases)[number],
) {
  const account = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const genesisSpec = fixtureGenesis({ [account.address]: balance });
  const config = genesisSpec.config;
  const node = await startPrivateClient(client, binary, genesisSpec);
  const { rpc, readReceipt, buildBlock, directory, logPath } = node;
  async function pool() {
    const result = await rpc<Pool>("txpool_content");
    return Object.fromEntries(
      Object.entries(result).map(([kind, accounts]) => [
        kind,
        Object.entries(accounts)
          .filter(
            ([address]) =>
              address.toLowerCase() === account.address.toLowerCase(),
          )
          .flatMap(([, entries]) =>
            Object.values(entries).map((tx) => ({
              hash: tx.hash,
              nonce: tx.nonce,
            })),
          ),
      ]),
    );
  }
  function hashes(value: Awaited<ReturnType<typeof pool>>) {
    return Object.values(value)
      .flat()
      .map((tx) => tx.hash);
  }
  async function send(raw: Hex) {
    try {
      return {
        hash: await rpc<Hex>("eth_sendRawTransaction", [raw]),
        error: null,
      };
    } catch (error) {
      return {
        hash: null,
        error: error instanceof Error ? error.message : "unknown RPC error",
      };
    }
  }

  try {
    const actualVersion = await rpc<string>("web3_clientVersion");
    assert(actualVersion.includes(CLIENTS[client].version));
    assert.equal(await rpc("eth_chainId"), "0x539");
    assert.equal(await rpc("net_peerCount"), "0x0");
    assert.equal(
      BigInt(await rpc<Hex>("eth_getBalance", [account.address, "latest"])),
      balance,
    );
    const genesis = await rpc<Block>("eth_getBlockByNumber", ["0x0", false]);
    // Start the normal post-Merge builder and confirm no unsigned fixture media entered state.
    const blocks = [await buildBlock()];
    const media: { raw: Hex; hash: Hex; nonce: number }[] = [];
    const admission: unknown[] = [];
    for (let i = 0; i < Math.max(1, scenario.submitted); i++) {
      const nonce = scenario.highest === 4 ? i + 1 : 1;
      const raw = await account.signTransaction({
        type: "eip1559",
        chainId: LOCAL_CHAIN_ID,
        nonce,
        to: recipient,
        value: 0n,
        data: toHex(`PATIO-local-H23-${i}`),
        gas: 30000n,
        maxFeePerGas: 2_000_000_000n * BigInt(i + 1),
        maxPriorityFeePerGas: 1_000_000_000n * BigInt(i + 1),
      });
      const hash = keccak256(raw);
      media.push({ raw, hash, nonce });
      if (scenario.submitted) {
        const response = await send(raw);
        assert.equal(
          response.hash,
          hash,
          response.error ?? "media hash mismatch",
        );
        await delay(100);
        const snapshot = await pool();
        assert(
          hashes(snapshot).includes(hash),
          "Media RPC hash without exact pool admission",
        );
        assert.equal(
          hashes(snapshot).length,
          scenario.highest === 4 ? i + 1 : 1,
        );
        admission.push({ hash, nonce, response, pool: snapshot });
      }
    }
    const before = await pool();
    const candidate = buildRetirementCandidate({
      session: account.address,
      chainId: LOCAL_CHAIN_ID,
      gap: 0,
      highestMediaNonce: scenario.highest,
      code: "0x",
      balance,
      ...fees,
      inventory: {
        freshExclusiveLocalKey: true,
        frozen: true,
        ordinaryNonces: [],
        authorityNonces: [],
        mediaNonces: media.map((tx) => tx.nonce),
      },
    });
    const authorizationList = await Promise.all(
      candidate.authorizationRequests.map((request) =>
        account.signAuthorization(request),
      ),
    );
    await validateRetirementSignatures(candidate, authorizationList);
    const {
      authorizationRequests: _requests,
      expectedNonce,
      sweepReserve: _reserve,
      ...transaction
    } = candidate;
    const raw = await account.signTransaction({
      ...transaction,
      authorizationList,
    });
    const expectedHash = keccak256(raw);
    const response = await send(raw);
    await delay(200);
    const after = await pool();
    blocks.push(await buildBlock());
    const receipt = await readReceipt(expectedHash);
    const nonceAfterClose = await rpc<Hex>("eth_getTransactionCount", [
      account.address,
      "latest",
    ]);
    const code = await rpc<Hex>("eth_getCode", [account.address, "latest"]);
    const balanceAfterClose = BigInt(
      await rpc<Hex>("eth_getBalance", [account.address, "latest"]),
    );
    const mediaReceipts = await Promise.all(
      media.map((tx) => readReceipt(tx.hash)),
    );
    assert(
      mediaReceipts.every((r) => r === null),
      "SAFETY FAILURE: included media",
    );
    assert.equal(code, "0x");
    let sweep: unknown = null;
    let staleResponses: unknown[] = [];
    if (receipt) {
      assert.equal(response.hash, expectedHash);
      assert(hashes(after).includes(expectedHash));
      assert.equal(receipt.status, "0x1");
      assert.equal(Number(BigInt(nonceAfterClose)), expectedNonce);
      assert.equal(
        balance - balanceAfterClose,
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice),
      );
      assert(
        blocks.some(
          (block) =>
            block.hash === receipt.blockHash &&
            block.transactions.includes(expectedHash),
        ),
      );
      staleResponses = await Promise.all(
        media.map(async (tx) => ({
          hash: tx.hash,
          response: await send(tx.raw),
        })),
      );
      assert.equal(
        hashes(await pool()).length,
        0,
        "Retired candidates still admitted",
      );
      const value = balanceAfterClose - 21000n * fees.maxFeePerGas;
      const sweepRaw = await account.signTransaction({
        type: "eip1559",
        chainId: LOCAL_CHAIN_ID,
        to: recipient,
        nonce: expectedNonce,
        gas: 21000n,
        value,
        data: "0x",
        ...fees,
      });
      const sweepHash = keccak256(sweepRaw);
      assert.equal((await send(sweepRaw)).hash, sweepHash);
      const sweepPool = await pool();
      assert(hashes(sweepPool).includes(sweepHash));
      blocks.push(await buildBlock());
      const sweepReceipt = await readReceipt(sweepHash);
      assert(sweepReceipt, "Normally selected sweep not included");
      assert.equal(sweepReceipt.status, "0x1");
      const remaining = BigInt(
        await rpc<Hex>("eth_getBalance", [account.address, "latest"]),
      );
      assert.equal(
        remaining,
        balanceAfterClose -
          value -
          BigInt(sweepReceipt.gasUsed) * BigInt(sweepReceipt.effectiveGasPrice),
      );
      assert.equal(
        BigInt(await rpc<Hex>("eth_getBalance", [recipient, "latest"])),
        value,
      );
      assert.equal(
        Number(
          BigInt(
            await rpc<Hex>("eth_getTransactionCount", [
              account.address,
              "latest",
            ]),
          ),
        ),
        expectedNonce + 1,
      );
      sweep = {
        hash: sweepHash,
        receipt: sweepReceipt,
        value,
        remaining,
        pool: sweepPool,
      };
    } else {
      assert.equal(nonceAfterClose, "0x0");
      assert.deepEqual(after, before);
      assert.equal(balanceAfterClose, balance);
    }
    const finalPool = await pool();
    assert(
      blocks.every((block) =>
        media.every((tx) => !block.transactions.includes(tx.hash)),
      ),
    );
    assert(
      (await Promise.all(media.map((tx) => readReceipt(tx.hash)))).every(
        (value) => value === null,
      ),
    );
    const internal = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) =>
        /authority already reserved|DelegatorHasPendingTx|delegator has pending/i.test(
          line,
        ),
      )
      .slice(-8);
    return {
      client,
      version: actualVersion,
      directory,
      genesis: genesis.hash,
      config,
      name: scenario.name,
      account: account.address,
      historicalSubmitted: scenario.submitted,
      signedMedia: media.map(({ hash, nonce }) => ({ hash, nonce })),
      admission,
      occupiedNonces: new Set(
        Object.values(before)
          .flat()
          .map((tx) => tx.nonce),
      ).size,
      retainedCandidates: hashes(before).length,
      before,
      close: {
        expectedHash,
        response,
        pool: after,
        admitted: hashes(after).includes(expectedHash),
        receipt,
        nonceAfterClose,
        code,
        balanceAfterClose,
        intrinsicGas: candidate.gas,
        maxCloseAndSweepReserve: (candidate.gas + 21000n) * fees.maxFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      },
      blocks,
      mediaReceipts,
      staleResponses,
      sweep,
      finalPool,
      internal,
    };
  } finally {
    await node.stop();
  }
}
async function main() {
  const client = process.argv[2];
  assert(
    client === "geth" || client === "nethermind",
    "Select pinned geth or nethermind",
  );
  const binary = process.env[CLIENTS[client].env];
  assert(
    binary && binary.startsWith("/"),
    "Explicit absolute pinned local client binary required",
  );
  const results = [];
  for (const scenario of cases) {
    console.error(`Running ${client} ${scenario.name} in fresh private state`);
    results.push(await runCase(client, binary, scenario));
  }
  console.log(
    JSON.stringify(
      {
        chainId: LOCAL_CHAIN_ID,
        fork: "Prague",
        p2p: "UNTESTED: peerless controlled Engine API",
        results,
      },
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

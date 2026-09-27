/** Shared H2.3/H2.4 PRIVATE process fixture, no production imports. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  openSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { toHex, zeroAddress, zeroHash, type Hex } from "viem";
import { LOCAL_CHAIN_ID } from "./candidate";
export const CLIENTS = {
  reth: { version: "2.6.0", commit: "73a3a008", env: "PATIO_R1_RETH" },
  geth: { version: "1.17.5", commit: "9621c6ad", env: "PATIO_H23_GETH" },
  nethermind: {
    version: "1.39.3",
    commit: "28cbe2a0",
    env: "PATIO_H23_NETHERMIND",
  },
} as const;
export type Client = keyof typeof CLIENTS;
export interface Receipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
}
export interface Block {
  hash: Hex;
  timestamp: Hex;
  number: Hex;
  transactions: Hex[];
}

// Standard Prague system contracts, not a patched execution environment.
// Read from the separately downloaded, unmodified pinned upstream source.
function systemAllocations() {
  const sourceDirectory = process.env.PATIO_H23_GETH_SOURCE;
  assert(
    sourceDirectory,
    "Pinned Geth v1.17.5 source required for Prague genesis",
  );
  const source = readFileSync(
    join(sourceDirectory, "params/protocol_params.go"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "75d3e21af1997f1d6be1c4b72b15fae57dd76daef322d0628882b583453040e3",
  );
  return Object.fromEntries(
    [
      "BeaconRoots",
      "HistoryStorage",
      "WithdrawalQueue",
      "ConsolidationQueue",
    ].map((name) => {
      const address = source.match(
        new RegExp(
          `${name}Address\\s*= common.HexToAddress\\("(0x[0-9a-fA-F]+)"\\)`,
        ),
      )?.[1];
      const code = source.match(
        new RegExp(`${name}Code\\s*= common.FromHex\\("([0-9a-fA-F]+)"\\)`),
      )?.[1];
      assert(address && code);
      return [address, { balance: "0x0", nonce: "0x1", code: `0x${code}` }];
    }),
  );
}

export function fixtureGenesis(allocations: Record<string, bigint>) {
  const config = {
    chainId: LOCAL_CHAIN_ID,
    homesteadBlock: 0,
    eip150Block: 0,
    eip155Block: 0,
    eip158Block: 0,
    byzantiumBlock: 0,
    constantinopleBlock: 0,
    petersburgBlock: 0,
    istanbulBlock: 0,
    berlinBlock: 0,
    londonBlock: 0,
    shanghaiTime: 0,
    cancunTime: 0,
    pragueTime: 0,
    terminalTotalDifficulty: 0,
    blobSchedule: {
      cancun: { target: 3, max: 6, baseFeeUpdateFraction: 3338477 },
      prague: { target: 6, max: 9, baseFeeUpdateFraction: 5007716 },
    },
  };
  return {
    config,
    nonce: "0x0",
    timestamp: "0x1",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    difficulty: "0x0",
    mixHash: zeroHash,
    coinbase: zeroAddress,
    baseFeePerGas: "0x3b9aca00",
    alloc: {
      ...systemAllocations(),
      ...Object.fromEntries(
        Object.entries(allocations).map(([address, balance]) => [
          address,
          { balance: toHex(balance) },
        ]),
      ),
    },
  };
}
export async function startPrivateClient(
  client: Client,
  binary: string,
  genesis: ReturnType<typeof fixtureGenesis>,
  slot = 0,
  p2p = false,
  peerCapacity: "historical-two" | "client-default" = "historical-two",
  rpcBase = 18647,
) {
  const directory = mkdtempSync(join(tmpdir(), `patio-h24-${client}-${slot}-`));
  const secret = randomBytes(32);
  writeFileSync(join(directory, "jwt"), secret.toString("hex"), {
    mode: 0o600,
  });
  writeFileSync(join(directory, "genesis.json"), JSON.stringify(genesis));
  const environment = {
    ...process.env,
    DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(directory, "dotnet"),
  };
  const version = spawnSync(
    binary,
    [client === "geth" ? "version" : "--version"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(version.status, 0, version.stderr);
  assert(
    version.stdout.includes(CLIENTS[client].version) &&
      version.stdout.includes(CLIENTS[client].commit),
  );
  const rpcPort = rpcBase + slot * 10,
    enginePort = rpcPort + 1,
    p2pPort = rpcPort + 2;
  let args: string[];
  if (client === "reth") {
    const shared = [
      "--datadir",
      join(directory, "db"),
      "--chain",
      join(directory, "genesis.json"),
    ];
    const init = spawnSync(
      binary,
      ["init", ...shared, "--log.file.max-files", "0"],
      { encoding: "utf8" },
    );
    assert.equal(init.status, 0, init.stderr);
    args = [
      "node",
      ...shared,
      "--disable-discovery",
      "--nat",
      "none",
      "--no-persist-peers",
      "--addr",
      "127.0.0.1",
      "--port",
      String(p2pPort),
      "--netrestrict",
      "127.0.0.0/8,::1/128",
      "--ipcdisable",
      "--http",
      "--http.addr",
      "127.0.0.1",
      "--http.port",
      String(rpcPort),
      "--http.api",
      "eth,web3,net,txpool,admin",
      "--ws",
      "--ws.addr",
      "127.0.0.1",
      "--ws.port",
      String(rpcPort + 3),
      "--ws.api",
      "eth",
      "--authrpc.addr",
      "127.0.0.1",
      "--authrpc.port",
      String(enginePort),
      "--authrpc.jwtsecret",
      join(directory, "jwt"),
      "--log.file.directory",
      join(directory, "logs"),
      "--log.file.max-files",
      "1",
    ];
  } else if (client === "geth") {
    const init = spawnSync(
      binary,
      [
        "--datadir",
        join(directory, "db"),
        "init",
        join(directory, "genesis.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(init.status, 0, init.stderr);
    args = [
      "--datadir",
      join(directory, "db"),
      "--networkid",
      "1337",
      "--syncmode",
      "full",
      "--maxpeers",
      // Normal Geth default: a cap of two artificially allowed only one
      // inbound connection, preventing the three-process private triangle.
      p2p ? "50" : "0",
      "--nodiscover",
      "--port",
      p2p ? String(p2pPort) : "0",
      "--nat",
      "none",
      "--netrestrict",
      "127.0.0.0/8,::1/128",
      "--bootnodes",
      "",
      "--ipcdisable",
      "--http",
      "--http.addr",
      "127.0.0.1",
      "--http.port",
      String(rpcPort),
      "--http.api",
      "eth,web3,net,txpool,admin",
      "--authrpc.addr",
      "127.0.0.1",
      "--authrpc.port",
      String(enginePort),
      "--authrpc.jwtsecret",
      join(directory, "jwt"),
      "--verbosity",
      "5",
    ];
  } else {
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({
        Init: {
          ChainSpecPath: join(directory, "genesis.json"),
          BaseDbPath: join(directory, "db"),
          DiscoveryEnabled: false,
          PeerManagerEnabled: p2p,
          MemoryHint: 512000000,
        },
        Sync: { NetworkingEnabled: p2p, SynchronizationEnabled: p2p },
        Network: {
          // Historical H2.4 admission reproductions retain their original override.
          // Full-app fixtures use the client's normal capacity: a two-slot cap
          // triggers SyncPeerPool.DropWorstPeer at every full-pool review.
          ...(p2p && peerCapacity === "client-default"
            ? {}
            : { ActivePeersMaxCount: p2p ? 2 : 0 }),
          P2PPort: p2pPort,
          DiscoveryPort: p2pPort,
          LocalIp: p2p ? "::1" : "127.0.0.1",
          ExternalIp: p2p ? "::1" : "127.0.0.1",
        },
        JsonRpc: {
          Enabled: true,
          Host: "127.0.0.1",
          Port: rpcPort,
          EnabledModules: ["Eth", "Net", "Web3", "TxPool", "Admin"],
          EngineHost: "127.0.0.1",
          EnginePort: enginePort,
          JwtSecretFile: join(directory, "jwt"),
        },
        Merge: { Enabled: true },
        Metrics: { Enabled: false },
      }),
    );
    args = [
      "--config",
      join(directory, "config.json"),
      "--data-dir",
      directory,
      "--log",
      "TRACE",
    ];
  }
  const logPath = join(directory, "client.log");
  const log = openSync(logPath, "w", 0o600);
  const child = spawn(binary, args, {
    env: environment,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  let id = 0;
  async function rpc<T>(
    method: string,
    params: unknown[] = [],
    engine = false,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const head = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    const token = `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
    const response = await fetch(
      `http://127.0.0.1:${engine ? enginePort : rpcPort}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(engine ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: requestSignal
          ? AbortSignal.any([requestSignal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      },
    );
    const result = (await response.json()) as {
      result: T;
      error?: { code: number; message: string };
    };
    if (result.error)
      throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.result;
  }
  async function readReceipt(hash: Hex): Promise<Receipt | null> {
    const receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [
      hash,
    ]);
    if (!receipt) return null;
    // Never export full RPC responses or logs, only canonical evidence metadata.
    const {
      transactionHash,
      blockHash,
      blockNumber,
      status,
      gasUsed,
      effectiveGasPrice,
    } = receipt;
    assert.equal(transactionHash, hash);
    const block = await rpc<Block>("eth_getBlockByNumber", [
      blockNumber,
      false,
    ]);
    assert.equal(block.hash, blockHash);
    assert(block.transactions.includes(hash));
    return {
      transactionHash,
      blockHash,
      blockNumber,
      status,
      gasUsed,
      effectiveGasPrice,
    };
  }

  async function buildBlock(importers: { rpc: typeof rpc }[] = []) {
    const parent = await rpc<Block>("eth_getBlockByNumber", ["latest", false]);
    const state = {
      headBlockHash: parent.hash,
      safeBlockHash: zeroHash,
      finalizedBlockHash: zeroHash,
    };
    const result = await rpc<{
      payloadId: Hex;
      payloadStatus: { status: string };
    }>(
      "engine_forkchoiceUpdatedV3",
      [
        state,
        {
          timestamp: toHex(BigInt(parent.timestamp) + 12n),
          prevRandao: zeroHash,
          suggestedFeeRecipient: zeroAddress,
          withdrawals: [],
          parentBeaconBlockRoot: zeroHash,
        },
      ],
      true,
    );
    assert.equal(result.payloadStatus.status, "VALID");
    assert(result.payloadId);
    await delay(1200); // bounded normal builder opportunity, not tx expiry/eviction
    const payload = await rpc<{
      executionPayload: { blockHash: Hex; transactions: Hex[] };
      executionRequests: Hex[];
    }>("engine_getPayloadV4", [result.payloadId], true);
    const validation = await rpc<{ status: string }>(
      "engine_newPayloadV4",
      [payload.executionPayload, [], zeroHash, payload.executionRequests],
      true,
    );
    assert.equal(validation.status, "VALID");
    await rpc(
      "engine_forkchoiceUpdatedV3",
      [{ ...state, headBlockHash: payload.executionPayload.blockHash }, null],
      true,
    );
    for (const importer of importers) {
      const imported = await importer.rpc<{ status: string }>(
        "engine_newPayloadV4",
        [payload.executionPayload, [], zeroHash, payload.executionRequests],
        true,
      );
      assert.equal(imported.status, "VALID");
      const adopted = await importer.rpc<{ payloadStatus: { status: string } }>(
        "engine_forkchoiceUpdatedV3",
        [{ ...state, headBlockHash: payload.executionPayload.blockHash }, null],
        true,
      );
      assert.equal(adopted.payloadStatus.status, "VALID");
    }
    const canonical = await rpc<Block>("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    assert.equal(canonical.hash, payload.executionPayload.blockHash);
    // Export only identities, never the signed payloads returned by Engine API.
    return {
      hash: canonical.hash,
      number: canonical.number,
      transactions: canonical.transactions,
    };
  }

  async function stop() {
    child.kill("SIGTERM");
    for (
      let i = 0;
      i < 50 && child.exitCode === null && child.signalCode === null;
      i++
    )
      await delay(100);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Client exited: ${logPath}`);
      try {
        await rpc("web3_clientVersion");
        ready = true;
        break;
      } catch {
        await delay(200);
      }
    }
    assert(ready, `Client startup timeout: ${logPath}`);
    assert.equal(await rpc("eth_chainId"), "0x539");
    return {
      client,
      directory,
      logPath,
      rpc,
      readReceipt,
      buildBlock,
      stop,
      wsPort: rpcPort + 3,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
export type PrivateClient = Awaited<ReturnType<typeof startPrivateClient>>;

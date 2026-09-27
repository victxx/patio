import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import type {
  Erc4337CanonicalReceipt,
  Erc4337ChainReader,
} from "./erc4337-adapter";
import type { BrowserEthereumRpc } from "./direct-hoodi";

const ENTRY_POINT_READ_ABI = parseAbi([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

interface RpcReceipt {
  transactionHash?: unknown;
  blockHash?: unknown;
  blockNumber?: unknown;
  status?: unknown;
  logs?: unknown;
}

interface RpcBlock {
  timestamp?: unknown;
}

function hash(value: unknown): Hex | null {
  return typeof value === "string" &&
    isHex(value, { strict: true }) &&
    value.length === 66
    ? value
    : null;
}

function quantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !isHex(value, { strict: true })) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function canonicalReceipt(
  value: RpcReceipt | null,
): Erc4337CanonicalReceipt | null {
  if (!value) return null;
  const transactionHash = hash(value.transactionHash);
  const blockHash = hash(value.blockHash);
  const blockNumber = quantity(value.blockNumber);
  const status = quantity(value.status);
  if (
    !transactionHash ||
    !blockHash ||
    blockNumber === null ||
    (status !== 0n && status !== 1n) ||
    !Array.isArray(value.logs)
  ) {
    throw new Error("Canonical RPC returned a malformed transaction receipt.");
  }
  const logs = value.logs.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Canonical RPC returned a malformed EntryPoint log.");
    }
    const log = item as Record<string, unknown>;
    const address =
      typeof log.address === "string" && isAddress(log.address)
        ? getAddress(log.address)
        : null;
    const data =
      typeof log.data === "string" && isHex(log.data, { strict: true })
        ? log.data
        : null;
    const topics = Array.isArray(log.topics) ? log.topics.map(hash) : null;
    const logTransactionHash = hash(log.transactionHash);
    const logBlockHash = hash(log.blockHash);
    const logBlockNumber = quantity(log.blockNumber);
    if (
      !address ||
      !data ||
      !topics ||
      topics.some((topic) => topic === null) ||
      !logTransactionHash ||
      !logBlockHash ||
      logBlockNumber === null
    ) {
      throw new Error("Canonical RPC returned a malformed EntryPoint log.");
    }
    return {
      address,
      data,
      topics: topics as Hex[],
      transactionHash: logTransactionHash,
      blockHash: logBlockHash,
      blockNumber: logBlockNumber,
    };
  });
  return {
    transactionHash,
    blockHash,
    blockNumber,
    status: status === 1n ? "success" : "reverted",
    logs,
  };
}

async function entryPointRead(input: {
  rpc: Pick<BrowserEthereumRpc, "request">;
  entryPoint: Address;
  functionName: "getNonce" | "balanceOf";
  args: readonly [Address, bigint] | readonly [Address];
}): Promise<bigint> {
  const data =
    input.functionName === "getNonce"
      ? encodeFunctionData({
          abi: ENTRY_POINT_READ_ABI,
          functionName: "getNonce",
          args: input.args as readonly [Address, bigint],
        })
      : encodeFunctionData({
          abi: ENTRY_POINT_READ_ABI,
          functionName: "balanceOf",
          args: input.args as readonly [Address],
        });
  const result = await input.rpc.request<Hex>("eth_call", [
    { to: input.entryPoint, data },
    "latest",
  ]);
  return decodeFunctionResult({
    abi: ENTRY_POINT_READ_ABI,
    functionName: input.functionName,
    data: result,
  });
}

/** Read-only canonical chain adapter. It deliberately exposes no send method. */
export function browserErc4337ChainReader(
  rpc: Pick<BrowserEthereumRpc, "request">,
): Erc4337ChainReader {
  return {
    async chainId() {
      return Number(BigInt(await rpc.request<Hex>("eth_chainId")));
    },
    async latestTimestamp() {
      const block = await rpc.request<RpcBlock>("eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      const timestamp = quantity(block?.timestamp);
      if (timestamp === null) {
        throw new Error("Canonical RPC returned a malformed block timestamp.");
      }
      return timestamp;
    },
    code(address) {
      return rpc.request<Hex>("eth_getCode", [address, "latest"]);
    },
    async balance(address) {
      return BigInt(
        await rpc.request<Hex>("eth_getBalance", [address, "latest"]),
      );
    },
    entryPointNonce(input) {
      return entryPointRead({
        rpc,
        entryPoint: input.entryPoint,
        functionName: "getNonce",
        args: [input.sender, input.key],
      });
    },
    entryPointDeposit(input) {
      return entryPointRead({
        rpc,
        entryPoint: input.entryPoint,
        functionName: "balanceOf",
        args: [input.sender],
      });
    },
    async receipt(transactionHash) {
      return canonicalReceipt(
        await rpc.request<RpcReceipt | null>("eth_getTransactionReceipt", [
          transactionHash,
        ]),
      );
    },
  };
}

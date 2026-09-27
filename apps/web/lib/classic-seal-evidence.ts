import type { Address, Hex } from "viem";
import {
  flattenTxpoolTransactions,
  type BrowserEthereumRpc,
} from "./direct-hoodi";

export type ExpectedClassicSeal = {
  account: Address;
  chainId: number;
  nonce: bigint;
  maxFee: bigint;
  tip: bigint;
  hash?: Hex;
};

/** Pending evidence only, NOT inclusion/exclusion/finality. A hash-only RPC
 * response cannot authorize the release; all approved empty-seal fields match. */
export function matchesClassicSeal(
  value: unknown,
  expected: ExpectedClassicSeal,
): boolean {
  if (!value || typeof value !== "object") return false;
  const tx = value as Record<string, unknown>;
  const same = (a: unknown, b: string) =>
    typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  const quantity = (a: unknown) =>
    typeof a === "string" && /^0x[0-9a-f]+$/i.test(a) ? BigInt(a) : -1n;
  return (
    (!expected.hash || same(tx.hash, expected.hash)) &&
    same(tx.from, expected.account) &&
    same(tx.to, expected.account) &&
    quantity(tx.nonce) === expected.nonce &&
    quantity(tx.value) === 0n &&
    (tx.input ?? tx.data) === "0x" &&
    quantity(tx.gas) === 21000n &&
    quantity(tx.maxFeePerGas) === expected.maxFee &&
    quantity(tx.maxPriorityFeePerGas) === expected.tip &&
    (tx.chainId === undefined ||
      quantity(tx.chainId) === BigInt(expected.chainId)) &&
    (tx.type === undefined || quantity(tx.type) === 2n)
  );
}

export async function readClassicSealEvidence(
  rpc: Pick<BrowserEthereumRpc, "txpoolContentFrom" | "transaction">,
  expected: ExpectedClassicSeal & { hash: Hex },
): Promise<boolean> {
  const pool = await rpc.txpoolContentFrom(expected.account).catch(() => null);
  if (
    flattenTxpoolTransactions(pool).some((tx) =>
      matchesClassicSeal(tx, expected),
    )
  )
    return true;
  const tx = await rpc.transaction(expected.hash).catch(() => null);
  return matchesClassicSeal(tx, expected);
}

import type { Address, Hex } from "viem";
import {
  flattenTxpoolTransactions,
  type BrowserEthereumRpc,
} from "./direct-hoodi";

/** Advisory snapshot AFTER an acknowledged media submission. Not a delivery
 * receipt, not a resend policy, and never sufficient to release the gap nonce.
 * Missing/failed observation must not stall the recording queue for 40 polls.
 * Seal observation before release keeps its separate, mandatory check. */
export async function observeClassicMedia(
  rpc: Pick<BrowserEthereumRpc, "txpoolContentFrom">,
  account: Address,
  hash: Hex,
): Promise<"observed" | "not-observed" | "read-failed"> {
  try {
    const content = await rpc.txpoolContentFrom(account);
    return flattenTxpoolTransactions(content).some(
      (tx) => tx.hash.toLowerCase() === hash.toLowerCase(),
    )
      ? "observed"
      : "not-observed";
  } catch {
    return "read-failed";
  }
}

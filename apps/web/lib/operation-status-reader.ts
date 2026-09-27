import type { EoaOperation, OperationStatusReader } from "@patio/wallet-core";

import type { BrowserEthereumRpc } from "./direct-hoodi";

/** A receipt-only adapter. It makes no mempool claim when a receipt is absent. */
export function browserEvmOperationStatusReader(
  rpc: Pick<BrowserEthereumRpc, "receipt">,
): OperationStatusReader {
  return {
    async readEoaStatus(operation: EoaOperation) {
      const receipt = await rpc.receipt(operation.hash);
      if (!receipt) {
        return { status: "pending", observedAtMs: Date.now() };
      }
      return {
        status: receipt.status === "0x1" ? "included" : "failed",
        observedAtMs: Date.now(),
      };
    },
  };
}

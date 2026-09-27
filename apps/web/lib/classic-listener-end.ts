import type { Address, Hex } from "viem";
import type {
  BrowserEthereumRpc,
  DirectSessionDescriptor,
} from "./direct-hoodi";

/** Driven by the existing media poll, with no timer of its own. Slow canonical
 * reads must not hold the txpool poll hostage and miss video replacements. */
export function createClassicEndProbe(
  rpc: Parameters<typeof readClassicEnd>[0],
  session: DirectSessionDescriptor,
  now = Date.now,
) {
  let evidence: Awaited<ReturnType<typeof readClassicEnd>> | undefined;
  let pending = false;
  let disposed = false;
  let nextCheck = 0;
  return {
    poll() {
      if (!disposed && !pending && !evidence?.ended && now() >= nextCheck) {
        pending = true;
        nextCheck = now() + 3_000;
        void readClassicEnd(rpc, session)
          .then((result) => {
            if (!disposed) evidence = result;
          })
          .catch(() => {
            // No evidence of end. Existing pool reads still surface connection
            // failures; this read is retried on a later bounded poll, never a send.
            if (!disposed) evidence = undefined;
          })
          .finally(() => {
            pending = false;
          });
      }
      return evidence;
    },
    dispose() {
      disposed = true;
    },
  };
}

/** Uses the existing poll, never a pending release. Registry v1 links have no
 * terminal bound: canonical consumption of the gap ends their live reception,
 * but makes no claim about all media winners, return or finality. */
export async function readClassicEnd(
  rpc: Pick<BrowserEthereumRpc, "receipt" | "transaction" | "request">,
  session: DirectSessionDescriptor,
): Promise<{
  ended: boolean;
  reason: string;
  nonce?: string;
  blockHash?: Hex;
}> {
  if (session.transportMode !== "classic-v2" || !session.classicEnd) {
    const block = await rpc.request<{ hash: Hex; number: Hex }>(
      "eth_getBlockByNumber",
      ["latest", false],
    );
    const nonce = BigInt(
      await rpc.request<Hex>("eth_getTransactionCount", [
        session.sessionAddress,
        block.number,
      ]),
    );
    const recheck = await rpc.request<{ hash: Hex }>("eth_getBlockByNumber", [
      block.number,
      false,
    ]);
    if (recheck.hash !== block.hash)
      throw new Error("Classic canonical end changed; possible reorg");
    return {
      ended: nonce > BigInt(session.nonceStart),
      reason: "legacy-gap-consumed-terminal-bound-unknown",
      nonce: nonce.toString(),
      blockHash: block.hash,
    };
  }
  const { releaseHash, mediaNonceEnd } = session.classicEnd;
  const receipt = await rpc.receipt(releaseHash);
  if (!receipt)
    return { ended: false, reason: "classic-release-pending-or-unknown" };
  if (
    receipt.transactionHash.toLowerCase() !== releaseHash.toLowerCase() ||
    !receipt.blockHash ||
    BigInt(receipt.status) !== 1n
  )
    throw new Error("Classic release evidence invalid; end unconfirmed");
  const tx = await rpc.transaction(releaseHash);
  const same = (address: Address | null | undefined) =>
    address?.toLowerCase() === session.sessionAddress.toLowerCase();
  if (
    !tx ||
    tx.hash.toLowerCase() !== releaseHash.toLowerCase() ||
    !same(tx.from) ||
    !same(tx.to) ||
    BigInt(tx.nonce) !== BigInt(session.nonceStart) ||
    BigInt(tx.value) !== 0n ||
    tx.input !== "0x" ||
    (tx.type !== undefined && BigInt(tx.type) !== 2n)
  )
    throw new Error("Classic release transaction mismatch");
  const block = await rpc.request<{ hash: Hex; number: Hex }>(
    "eth_getBlockByNumber",
    ["latest", false],
  );
  const nonce = BigInt(
    await rpc.request<Hex>("eth_getTransactionCount", [
      session.sessionAddress,
      block.number,
    ]),
  );
  const releaseBlock = await rpc.request<{ hash: Hex } | null>(
    "eth_getBlockByNumber",
    [receipt.blockNumber, false],
  );
  const recheck = await rpc.request<{ hash: Hex }>("eth_getBlockByNumber", [
    block.number,
    false,
  ]);
  if (releaseBlock?.hash !== receipt.blockHash || recheck.hash !== block.hash)
    throw new Error("Classic canonical end changed; possible reorg");
  return {
    ended: nonce > BigInt(mediaNonceEnd),
    reason:
      nonce > BigInt(mediaNonceEnd)
        ? "classic-media-nonces-consumed-not-finalized"
        : "classic-nonces-unreconciled",
    nonce: nonce.toString(),
    blockHash: block.hash,
  };
}

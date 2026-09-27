/** One bounded read-only audit of the already executed authorized B3. No signer. */
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Address, Hex } from "viem";
import { LabRpc } from "./rpc";
import { json } from "./core";

async function main() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Node 24 required");
  const evidencePath = "reports/patio-b3-preparation-1790401444576.json";
  const report = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    status: string;
    signatures: { role: string; hash: Hex; nonce: string }[];
    accounting: {
      fundingWei: string;
      sessionGasWei: string;
      returnedWei: string;
      residualWei: string;
    };
  };
  if (
    report.status !== "reconciled-finality-pending" ||
    report.signatures.length !== 8
  )
    throw new Error("Expected completed single execution absent");
  const env: Record<string, string | undefined> = {};
  for (const file of [".env", "apps/web/.env.local"]) {
    try {
      const parsed = parseEnv(readFileSync(file, "utf8"));
      const name = "PATIO_HOODI_CHAINSTACK_RPC_URL";
      if (parsed[name]) env[name] = parsed[name];
    } catch {
      /* optional local file; LabRpc fails if neither supplied */
    }
  }
  const rpc = new LabRpc("chainstack", 32, fetch, env);
  const session: Address = "0x03eC71DE6C2abf4E792A6574CbF3371baE83a60A";
  const operator: Address = "0xca490deA7D7D79Bac4537D5Fe68fF10cd9c7EbEd";
  if ((await rpc.chainId()) !== 560048) throw new Error("Wrong chain");
  type Block = { number: Hex; hash: Hex };
  const head = await rpc.request<Block>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  const finalized = await rpc.request<Block>("eth_getBlockByNumber", [
    "finalized",
    false,
  ]);
  const [balance, nonce, pendingNonce, code, operatorCode] = await Promise.all([
    rpc.request<Hex>("eth_getBalance", [session, head.number]),
    rpc.request<Hex>("eth_getTransactionCount", [session, head.number]),
    rpc.request<Hex>("eth_getTransactionCount", [session, "pending"]),
    rpc.request<Hex>("eth_getCode", [session, head.number]),
    rpc.request<Hex>("eth_getCode", [operator, head.number]),
  ]);
  const rows = [];
  for (const signature of report.signatures) {
    const receipt = await rpc.receipt(signature.hash);
    if (!receipt) {
      if (signature.role !== "media")
        throw new Error("Expected cleanup receipt absent");
      rows.push({
        ...signature,
        receipt: null,
        nonceStale: BigInt(nonce) > BigInt(signature.nonce),
      });
      continue;
    }
    const block = await rpc.request<Block>("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    const tx = await rpc.transaction(signature.hash);
    if (
      !tx ||
      tx.from.toLowerCase() !== session.toLowerCase() ||
      BigInt(tx.nonce) !== BigInt(signature.nonce) ||
      receipt.blockHash !== block.hash ||
      receipt.transactionHash !== signature.hash ||
      BigInt(receipt.status) !== 1n
    )
      throw new Error("Canonical receipt identity mismatch");
    if (
      signature.role === "sweep" &&
      (tx.to?.toLowerCase() !== operator.toLowerCase() ||
        BigInt(tx.value) !== BigInt(report.accounting.returnedWei))
    )
      throw new Error("Sweep recipient/value mismatch");
    rows.push({
      ...signature,
      receipt: {
        block: receipt.blockNumber,
        blockHash: receipt.blockHash,
        success: true,
        gasWei: BigInt(receipt.gasUsed!) * BigInt(receipt.effectiveGasPrice!),
      },
      finalized: BigInt(receipt.blockNumber) <= BigInt(finalized.number),
    });
  }
  const checkedHead = await rpc.request<Block>("eth_getBlockByNumber", [
    head.number,
    false,
  ]);
  if (
    checkedHead.hash !== head.hash ||
    BigInt(nonce) !== 3n ||
    code !== "0x" ||
    BigInt(balance) !== BigInt(report.accounting.residualWei)
  )
    throw new Error("Final state changed");
  const result = {
    schema: 1,
    checkedAt: new Date().toISOString(),
    source: evidencePath,
    provider: "chainstack",
    chainId: 560048,
    session,
    operator,
    head: { number: head.number, hash: head.hash },
    finalized: { number: finalized.number, hash: finalized.hash },
    nonce: BigInt(nonce),
    pendingNonce: BigInt(pendingNonce),
    code,
    operatorCode,
    balanceWei: BigInt(balance),
    rows,
    mediaHashesChecked: rows.filter((r) => r.role === "media").length,
    mediaReceiptsFound: rows.filter(
      (r) => r.role === "media" && r.receipt !== null,
    ).length,
    accounting: report.accounting,
    rpcReads: rpc.calls,
    noWrites: true,
    inspectorClosedAfterRepair: true,
  };
  writeFileSync(
    "reports/patio-b3-execution-audit-2026-09-26.json",
    json(result),
    { mode: 0o600 },
  );
  console.log(json(result));
}
void main().catch(() => {
  console.error("Bounded read-only audit failed; no sends, no retries");
  process.exitCode = 1;
});

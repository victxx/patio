// Exactly four QuickNode reads plus one existing-source canonical comparison.
// No signer, sends, pool enumeration, retry, or arbitrary endpoint input.
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
const local = parseEnv(readFileSync(".env.local", "utf8"));
const existing = Object.assign(
  {},
  ...[".env", "apps/web/.env.local"].map((p) => {
    try {
      return parseEnv(readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  }),
);
const urls = {
  quicknode: local.PATIO_HOODI_QUICKNODE_RPC_URL,
  chainstack: existing.PATIO_HOODI_CHAINSTACK_RPC_URL,
};
const control = "0x000000000000000000000000000000000000dEaD";
const report = {
  checkedAt: new Date().toISOString(),
  control,
  maximumRequests: 5,
  requests: [],
  noWrites: true,
};
let count = 0;
async function read(provider, method, params = []) {
  if (++count > 5) throw Error("Read budget exceeded");
  const row = { provider, method };
  report.requests.push(row);
  try {
    const response = await fetch(urls[provider], {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(6000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: count, method, params }),
    });
    row.http = response.status;
    const body = await response.json();
    if (body.error) {
      row.errorCode = body.error.code;
      row.error = String(body.error.message ?? "RPC error")
        .replace(/https?:\/\/\S+/g, "[endpoint omitted]")
        .slice(0, 180);
      return null;
    }
    if (!response.ok) {
      row.error = "HTTP error";
      return null;
    }
    row.outcome = "response";
    return body.result;
  } catch (e) {
    row.error = e?.cause?.code ?? e?.name ?? "network error";
    return null;
  }
}
const chain = await read("quicknode", "eth_chainId");
report.chainId = chain ? Number(BigInt(chain)) : null;
report.clientDeclared = await read("quicknode", "web3_clientVersion");
const block = await read("quicknode", "eth_getBlockByNumber", [
  "latest",
  false,
]);
report.block = block
  ? { number: block.number, hash: block.hash, timestamp: block.timestamp }
  : null;
const pool = await read("quicknode", "txpool_contentFrom", [control]);
report.pool = pool
  ? {
      expectedStructure:
        !!pool.pending &&
        !!pool.queued &&
        typeof pool.pending === "object" &&
        typeof pool.queued === "object",
      pendingEntries: Object.keys(pool.pending ?? {}).length,
      queuedEntries: Object.keys(pool.queued ?? {}).length,
    }
  : null;
if (block?.number) {
  const common = await read("chainstack", "eth_getBlockByNumber", [
    block.number,
    false,
  ]);
  report.canonicalMatch = common?.hash === block.hash;
}
report.requestCount = count;
writeFileSync(
  "reports/patio-quicknode-readonly-2026-09-26.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));

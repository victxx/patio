/** Explicit, bounded external RPC check; never signs or submits a valid tx. */
import { writeFileSync } from "node:fs";
import {
  HOODI_PROVIDERS,
  HoodiProviderPool,
  hoodiProviderUrls,
} from "../lib/hoodi-provider-pool";
async function main() {
  const pool = new HoodiProviderPool(hoodiProviderUrls(process.env));
  const results = [];
  for (const provider of HOODI_PROVIDERS)
    results.push(await pool.preflight(provider, true));
  const report = {
    observedAt: new Date().toISOString(),
    results,
    selectedReadProvider:
      results.find((r) => r.reads === "verified")?.provider ?? null,
    selectedPatioSender: null,
    publicTransport: "CLOSED",
    sendProbe:
      "Only empty 0x bytes; cannot encode a transaction. No admission or propagation proof.",
  };
  const path = process.env.PATIO_PROVIDER_REPORT;
  if (path) writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
void main().catch(() => {
  console.error("Provider preflight unavailable; credentials redacted");
  process.exitCode = 1;
});

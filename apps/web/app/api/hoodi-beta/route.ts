import {
  boundedJson,
  quickNodeBetaAdapter,
  HoodiBetaRpcError,
} from "../../../lib/hoodi-beta-server";
import type { HoodiBetaContext } from "../../../lib/hoodi-beta";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
let inFlight = 0;
const localFailureCategories: Record<string, string> = {
  "Invalid or oversized transaction": "transaction-size",
  "Media outside reviewed plan": "media-plan-mismatch",
  "Cleanup outside reviewed fees": "cleanup-fees-mismatch",
  "Expected seals not observed; release held": "seal-not-observed",
  "Return differs from reconciled state": "return-state-changed",
  "Plan outside beta budget": "plan-mismatch",
  "Wrong transaction chain, type or signer": "transaction-identity",
  "Wrong upstream chain": "upstream-chain",
  "QuickNode configuration missing": "configuration-missing",
};
export async function POST(request: Request) {
  if (process.env.PATIO_HOODI_BETA_ENABLED !== "true")
    return Response.json(
      { error: { message: "Hoodi beta is not enabled" } },
      { status: 403, headers },
    );
  const origin = request.headers.get("origin");
  // Next may reconstruct request.url with its internal listener hostname.
  // Host is the browser-facing authority (also behind Vercel's proxy).
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let sameOrigin = false;
  try {
    const parsed = new URL(origin ?? "");
    sameOrigin =
      parsed.host === host &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)));
  } catch {
    /* Invalid origin is refused before any upstream request. */
  }
  if (!sameOrigin || request.headers.get("content-type") !== "application/json")
    return Response.json(
      { error: { message: "Same-origin JSON request required" } },
      { status: 403, headers },
    );
  if (inFlight >= 24)
    return Response.json(
      { error: { message: "Beta capacity reached" } },
      { status: 429, headers },
    );
  let operation = "request";
  try {
    inFlight++;
    const b = (await boundedJson(request, 50000)) as {
      id?: number;
      action?: string;
      method?: string;
      params?: unknown[];
      session?: HoodiBetaContext;
    };
    const adapter = quickNodeBetaAdapter();
    operation =
      b.action === "review"
        ? "review"
        : b.method === "eth_sendRawTransaction"
          ? "send"
          : "read";
    const result =
      b.action === "review"
        ? await adapter.review(b.session ?? {})
        : typeof b.method === "string" && Array.isArray(b.params)
          ? await adapter.request(b.method, b.params, b.session)
          : undefined;
    if (result === undefined) throw Error("Invalid operation");
    return Response.json({ jsonrpc: "2.0", id: b.id, result }, { headers });
  } catch (cause) {
    // No reflected upstream messages, signed bytes, payloads, URLs or credentials.
    const failure = cause instanceof HoodiBetaRpcError ? cause : null;
    const category =
      failure?.category ??
      (cause instanceof Error
        ? localFailureCategories[cause.message]
        : undefined) ??
      "adapter-validation";
    // Only static category, numeric code and operation; no params or raw cause.
    console.warn("Patio Hoodi request", {
      operation,
      category,
      code: failure?.code ?? null,
    });
    return Response.json(
      {
        error: {
          code: failure?.code ?? -32000,
          category,
          message:
            operation === "read"
              ? "Unable to read Hoodi right now."
              : failure
                ? failure.message
                : operation === "send"
                  ? "Unable to confirm this transaction. Keep this tab open while its status is checked."
                  : operation === "review"
                    ? "Unable to prepare this broadcast right now. No funding was requested."
                    : "Unable to read Hoodi right now.",
        },
      },
      { status: 400, headers },
    );
  } finally {
    inFlight--;
  }
}

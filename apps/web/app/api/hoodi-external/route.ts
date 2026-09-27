import { randomUUID } from "node:crypto";
import {
  HoodiProviderPool,
  hoodiProviderUrls,
} from "../../../lib/hoodi-provider-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const leases = new Map<
  string,
  { expires: number; pinned: ReturnType<HoodiProviderPool["pinReadProvider"]> }
>();
const headers = { "Cache-Control": "no-store" };
let selecting = 0;
function enabled() {
  return process.env.PATIO_HOODI_EXTERNAL_PROVIDERS_ENABLED === "true";
}
export async function GET() {
  if (!enabled())
    return Response.json(
      { error: "External pool not configured" },
      { status: 503, headers },
    );
  for (const [id, lease] of leases)
    if (lease.expires < Date.now()) leases.delete(id);
  if (leases.size + selecting >= 64)
    return Response.json(
      { error: "Read provider capacity reached" },
      { status: 503, headers },
    );
  try {
    selecting++;
    const pinned = await new HoodiProviderPool(
      hoodiProviderUrls(process.env),
    ).selectReadProvider();
    const lease = randomUUID();
    leases.set(lease, { pinned, expires: Date.now() + 30 * 60_000 });
    return Response.json(
      { provider: pinned.provider, lease, evidence: pinned.evidence },
      { headers },
    );
  } catch {
    return Response.json(
      { error: "No verified Hoodi read provider" },
      { status: 503, headers },
    );
  } finally {
    selecting--;
  }
}
export async function POST(request: Request) {
  if (!enabled())
    return Response.json(
      { error: "External pool disabled" },
      { status: 503, headers },
    );
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json(
      { error: "Origin rejected" },
      { status: 403, headers },
    );
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing request");
    const bytes: number[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (bytes.length + part.value.length > 16_384)
          throw new Error("Request too large");
        bytes.push(...part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const text = new TextDecoder().decode(Uint8Array.from(bytes));
    const body = JSON.parse(text) as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    const lease = leases.get(
      request.headers.get("X-Patio-Provider-Lease") ?? "",
    );
    if (
      !lease ||
      lease.expires < Date.now() ||
      typeof body.method !== "string" ||
      !Array.isArray(body.params)
    )
      throw new Error("Invalid or expired read operation");
    const result = await lease.pinned.request(body.method, body.params);
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers });
  } catch {
    return Response.json(
      {
        error: {
          code: -32000,
          message:
            "Pinned Hoodi provider unavailable or request blocked; no fallback",
        },
      },
      { status: 503, headers },
    );
  }
}

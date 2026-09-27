/** Separate process: only metadata IPC in, actual provider lookup out. No signer import. */
import type { Hex } from "viem";
import {
  metadataHint,
  validateTransaction,
  type Context,
  type Hint,
} from "../hash-receiver/receiver";
import { LabRpc, RpcFailure } from "./rpc";
import { type Provider, delay } from "./core";

let context: Context | undefined;
let rpc: LabRpc | undefined;
let active = 0;
const seen = new Set<string>();
const postCloseQueue: Hint[] = [];
// Date.now in children is NOT compared: parent stamps IPC receipt with its own performance clock.
async function read(hint: Hint, phase: string) {
  if (!context || !rpc) return;
  const key = `${hint.transactionHash}:${phase}`;
  if (seen.has(key) || seen.size >= 16) return;
  if (active >= 2) {
    // Queue only the bounded after-close audit, never delay a media replacement for a reader ACK.
    if (phase === "after-close" && postCloseQueue.length < 5)
      postCloseQueue.push(hint);
    else
      process.send?.({
        kind: "observation",
        provider: rpc.provider,
        hash: hint.transactionHash,
        sequence: hint.sequence,
        phase,
        outcome: "concurrency-bound-not-read",
        calls: rpc.calls,
        responseBytes: rpc.responseBytes,
      });
    return;
  }
  seen.add(key);
  active++;
  const start = performance.now();
  const offsets = phase === "current" ? [0, 400, 800, 1200, 1800, 2400] : [0];
  try {
    for (const offset of offsets) {
      await delay(Math.max(0, start + offset - performance.now()));
      if (phase === "current" && performance.now() - start > 2800) break;
      const queryStart = performance.now();
      try {
        const t = await rpc.request<Record<string, unknown> | null>(
          "eth_getTransactionByHash",
          [hint.transactionHash],
        );
        let outcome = "null-not-global-absence";
        let digest: Hex | undefined;
        let bytes: number | undefined;
        if (t) {
          const included =
            t.blockHash !== null ||
            t.blockNumber !== null ||
            t.transactionIndex !== null;
          // R1 pending validator reused; included identity validated separately but NEVER counted as mempool delivery.
          const valid = await validateTransaction(
            {
              ...t,
              blockHash: null,
              blockNumber: null,
              transactionIndex: null,
            },
            hint,
            context,
          );
          digest = valid.digest;
          bytes = valid.bytes;
          outcome = included
            ? "validated-included-not-mempool"
            : "validated-pending";
        }
        process.send?.({
          kind: "observation",
          provider: rpc.provider,
          hash: hint.transactionHash,
          sequence: hint.sequence,
          phase,
          outcome,
          digest,
          bytes,
          queryMs: performance.now() - queryStart,
          calls: rpc.calls,
          responseBytes: rpc.responseBytes,
        });
        if (t) break;
      } catch (e) {
        process.send?.({
          kind: "observation",
          provider: rpc.provider,
          hash: hint.transactionHash,
          sequence: hint.sequence,
          phase,
          outcome: e instanceof RpcFailure ? e.message : "invalid-transaction",
          calls: rpc.calls,
          queryMs: performance.now() - queryStart,
          responseBytes: rpc.responseBytes,
        });
        // No retry on errors/429; null alone may be retried within the fixed window.
        break;
      }
    }
  } finally {
    active--;
    const next = postCloseQueue.shift();
    if (next)
      void read(next, "after-close").catch(() =>
        process.send?.({ kind: "reader-failed" }),
      );
  }
}
process.on(
  "message",
  (m: {
    kind: string;
    provider?: Provider;
    context?: Context;
    hint?: Hint;
    phase?: string;
  }) => {
    if (m.kind === "init" && !context && m.context && m.provider) {
      context = m.context;
      rpc = new LabRpc(m.provider, 40, fetch, process.env, true);
      process.send?.({ kind: "ready", provider: m.provider });
    } else if (m.kind === "lookup" && context) {
      try {
        void read(metadataHint(m.hint, context), m.phase ?? "current").catch(
          () => process.send?.({ kind: "reader-failed" }),
        );
      } catch {
        process.send?.({ kind: "invalid-hint" });
      }
    }
  },
);

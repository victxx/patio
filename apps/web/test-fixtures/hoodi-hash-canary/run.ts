/** Run ONLY as Node24 local CLI. Starts read-only, waits for exact user approval.
 * No HTTP server, browser import, public proxy, wallet secret, or automatic campaign. */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatEther, keccak256, type Hex } from "viem";
import type { ClassicRpc } from "../../lib/classic-session";
import { classicReceiptFee } from "../../lib/classic-session";
import type { Hint } from "../hash-receiver/receiver";
import {
  CHAIN,
  GENESIS,
  OPERATOR,
  PROVIDERS,
  CAPACITY,
  CADENCE,
  Permit,
  json,
  planFor,
  reviewId,
  retainedSession,
  mediaTx,
  packet,
  closeByHash,
  delay,
  type Review,
} from "./core";
import { LabRpc, RpcFailure } from "./rpc";
import {
  FundingLedger,
  observeFunding,
  PreMediaCancellation,
  cancellationId,
} from "./cancellation";

if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Node 24 required");
// Only the three authorized endpoint variables, no broad env export or new credentials.
for (const path of [".env", "apps/web/.env.local"])
  if (existsSync(path)) {
    const vars = parseEnv(readFileSync(path, "utf8"));
    for (const name of [
      "PATIO_HOODI_CHAINSTACK_RPC_URL",
      "PATIO_HOODI_ALCHEMY_RPC_URL",
      "PATIO_HOODI_DRPC_RPC_URL",
    ])
      if (vars[name]) process.env[name] = vars[name];
  }
type Block = { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex };
const epoch = performance.now(),
  now = () => Math.round(performance.now() - epoch);
const report: Record<string, unknown> = {
  schema: 1,
  experiment: "B3-classic-hash",
  startedAt: new Date().toISOString(),
  verdict: "B3 PREPARED — SPECIFIC TRANSACTION APPROVAL PENDING",
  mediaNature: "synthetic framing, NOT playable audio",
  status: "read-only-preflight",
  events: [],
  observations: [],
  candidates: [],
  publicSends: 0,
  limits: {
    preparationReads: 40,
    senderAndReconciliationReads: 900,
    readerReadsPerService: 40,
    totalRpcCeiling: 1084,
    sends: 8,
    mediaCadenceMs: CADENCE,
    perHashAttempts: 6,
    readerTimeoutMs: 600,
    readerConcurrencyPerService: 2,
  },
  publicGates: "unchanged-closed",
  productionProxy: "unchanged-read-only",
  signalling: "local metadata IPC only",
};
const output = resolve(`reports/patio-b3-preparation-${Date.now()}.json`);
const save = () => writeFileSync(output, json(report), { mode: 0o600 });
const event = (kind: string, data: Record<string, unknown> = {}) => {
  const events = report.events as unknown[];
  if (events.length < 200) events.push({ atMs: now(), kind, ...data });
  save();
};
const rpcs = PROVIDERS.map((p) => new LabRpc(p, p === "chainstack" ? 940 : 12));
const read = rpcs[0]!;
const account = privateKeyToAccount(generatePrivateKey()); // memory only; never output this object
const streamId: Hex = `0x${randomBytes(16).toString("hex")}`;
const children: ChildProcess[] = [];
let phase = "preparing";
let resolveFunding: ((hash: Hex) => void) | undefined;
let rejectFunding: ((reason: Error) => void) | undefined;
let busy = false;
const fail = (reason: string) => {
  phase = "held";
  report.status = "held";
  event("held", { reason });
  console.log(
    `HELD: ${reason}. Keep this process open; no automatic resend or new session.`,
  );
};

async function prepare() {
  const chain = await read.chainId();
  if (chain !== CHAIN) throw new Error("Chainstack is not Hoodi");
  const head = await read.request<Block>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  if (Date.now() / 1000 - Number(BigInt(head.timestamp)) > 300)
    throw new Error("Stale head");
  const finalized = await read.request<Block>("eth_getBlockByNumber", [
    "finalized",
    false,
  ]);
  const environment = [];
  for (const rpc of rpcs) {
    const observedChain = rpc === read ? chain : await rpc.chainId();
    const syncing = await rpc.request<unknown>("eth_syncing").catch((e) => {
      event("sync-method-unavailable", {
        provider: rpc.provider,
        reason: e instanceof RpcFailure ? e.message : "read error",
      });
      return "unknown-method-unavailable";
    });
    const common = await rpc.request<Block>("eth_getBlockByNumber", [
      finalized.number,
      false,
    ]);
    if (
      observedChain !== CHAIN ||
      (syncing !== false && syncing !== "unknown-method-unavailable") ||
      common.hash !== finalized.hash
    )
      throw new Error(`${rpc.provider}: chain/sync/common block mismatch`);
    environment.push({
      provider: rpc.provider,
      chainId: observedChain,
      syncing,
      referenceBlock: common.number,
      referenceHash: common.hash,
      backendAffinity: "unknown",
      nodeIndependence: "not-accredited",
    });
  }
  // One genesis lookup on the configured archive-capable alternative; no retries or pool enumeration.
  const genesis = await rpcs[1]!.request<Block>("eth_getBlockByNumber", [
    "0x0",
    false,
  ]);
  if (genesis.hash !== GENESIS) throw new Error("Unexpected Hoodi genesis");
  const [nonce, code, balance, operatorCode, operatorBalance, tipHex] =
    await Promise.all([
      read.latestTransactionCount(account.address),
      read.code(account.address),
      read.balance(account.address),
      read.code(OPERATOR),
      read.balance(OPERATOR),
      read.request<Hex>("eth_maxPriorityFeePerGas"),
    ]);
  if (nonce !== 0n || code !== "0x" || balance !== 0n)
    throw new Error("Fresh session preconditions failed");
  // Do not silently generalize return/funding support for a delegated/code-bearing operator.
  if (operatorCode !== "0x")
    throw new Error(
      "Operator has code; reviewed EOA funding/return plan unavailable",
    );
  const base = BigInt(head.baseFeePerGas),
    tip = BigInt(tipHex),
    fees = planFor(base, tip);
  const fundingGas = await read.estimateGas({
    from: OPERATOR,
    to: account.address,
    value: fees.returnPlan.requiredFundingWei,
    data: "0x",
  });
  if (fundingGas !== 21000n)
    throw new Error(
      "Funding gas differs from plain EOA transfer; review required",
    );
  const review: Review = {
    schema: 1,
    chainId: CHAIN,
    sender: "chainstack",
    readers: PROVIDERS,
    operator: OPERATOR,
    session: account.address,
    streamId,
    g: 0,
    m: 1,
    sweepNonce: 2,
    candidates: 5,
    cadenceMs: CADENCE,
    fundingWei: fees.returnPlan.requiredFundingWei,
    maximumSessionGasWei: fees.returnPlan.maximumExposureWei,
    marginWei: fees.returnPlan.safetyMarginWei,
    mediaFees: fees.plan.mediaFeeLadderWei,
    mediaTips: fees.plan.mediaPriorityFeeLadderWei,
    cleanupFee: fees.plan.sealMaxFeePerGasWei,
    cleanupTip: fees.plan.sealPriorityFeePerGasWei,
    mediaGas: 351720n,
    sweepGas: fees.returnPlan.sweepGasLimit,
    fundingGas,
    fundingFeeCap: 2n * base + tip,
    fundingTip: tip,
    quotedAt: Date.now(),
    block: head.number,
    blockHash: head.hash,
  };
  if (operatorBalance < review.fundingWei + fundingGas * review.fundingFeeCap)
    throw new Error("Operator balance insufficient; no top-up requested");
  report.environment = {
    genesis: genesis.hash,
    services: environment,
    head: head.number,
    headHash: head.hash,
  };
  report.review = review;
  report.reviewId = reviewId(review);
  report.quote = {
    base,
    tip,
    operatorBalance,
    operatorControl: "NOT VERIFIED IN WALLET; no wallet opened",
    nominalDurationMs: CAPACITY * CADENCE,
    maximumMediaWinnerWei: review.mediaGas * review.mediaFees.at(-1)!,
    releaseReserveWei: 21000n * review.cleanupFee,
    sweepReserveWei: review.sweepGas * review.cleanupFee,
    sealCompetesWithMediaNotAddedTwice: true,
    fundingGasEstimateWei: fundingGas * (base + tip),
    fundingGasMaximumWei: fundingGas * review.fundingFeeCap,
    preparationRequests: rpcs.map((r) => ({
      provider: r.provider,
      calls: r.calls,
    })),
  };
  event("prepared-no-signature-no-funding", { session: account.address });
  report.rpcAudit = rpcs.map((r) => ({
    provider: r.provider,
    calls: r.calls,
    requests: r.audit,
  }));
  save();
  return { review, fees };
}

async function main() {
  const { review, fees } = await prepare();
  const permit = new Permit(review);
  const sender: ClassicRpc = {
    request: read.request.bind(read),
    chainId: read.chainId.bind(read),
    receipt: read.receipt.bind(read),
    transaction: read.transaction.bind(read),
    latestTransactionCount: read.latestTransactionCount.bind(read),
    balance: read.balance.bind(read),
    code: read.code.bind(read),
    estimateGas: read.estimateGas.bind(read),
    sendRawTransaction: async (raw) => {
      const hash = keccak256(raw);
      return read
        .sendRegistered(raw, async (bytes) => {
          await permit.claimSend(bytes, session);
          report.publicSends = Number(report.publicSends) + 1;
          event("send-start", {
            hash,
            role: session.signatures.find((s) => s.hash === hash)?.role,
          });
        })
        .then(
          (result) => {
            if (result !== hash) throw new Error("Returned hash mismatch");
            event("send-response", { hash });
            return result;
          },
          (e) => {
            event("send-uncertain", { hash });
            throw e;
          },
        );
    },
  };
  const session = retainedSession(account, review, fees, read, sender, permit);
  const fundingLedger = new FundingLedger(review.fundingWei);
  // Constructed before approve/funding is available. Not present in the older retained process.
  const cancellation = new PreMediaCancellation({
    account,
    review,
    read,
    assertIdleUnsigned: () => permit.assertCancellationAvailable(session),
    claimExclusive: () => permit.claimCancellation(session),
    send: (raw, guard) =>
      read.sendRegistered(raw, async (bytes) => {
        await guard(bytes);
        report.publicSends = Number(report.publicSends) + 1;
        event("pre-media-cancellation-send", { hash: keccak256(bytes) });
      }),
    persist: () => persistSession(),
  });
  phase = "awaiting-approval";
  report.status = phase;
  save();
  console.log(
    json({
      verdict: report.verdict,
      reviewId: reviewId(review),
      review,
      fundingETH: formatEther(review.fundingWei),
      reportPath: output,
      warning:
        "Synthetic bytes may be included. Funds can remain held. No wallet ownership verified. No signatures or funding yet.",
    }),
  );
  console.log(
    "WAITING. Commands: status | approve <reviewId> <exact fundingWei> | funding <wallet hash> | unknown | recognize <fundingHash> <actualWei> | cancel-review | cancel <cancellationId> <maximumCostWei> | start | reconcile. Cancellation requires SEPARATE explicit approval. Do not close a funded/uncertain process.",
  );

  const persistSession = () => {
    report.signatures = session.signatures;
    report.financial = session.financial;
    report.observedFunding = fundingLedger.observation;
    report.fundingRecognition = fundingLedger.recognizedExcess;
    report.cancellation = cancellation.record;
    report.cancellationClaimed = cancellation.claimed;
    report.mediaIncluded = [...session.mediaIncluded];
    report.receipts = [...session.receipts.values()].map((r) => ({
      hash: r.transactionHash,
      block: r.blockNumber,
      blockHash: r.blockHash,
      status: r.status,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice,
    }));
    report.returnedWei = session.returned;
    report.residualWei = session.residual;
    report.senderRequests = read.calls;
    report.rpcAudit = rpcs.map((r) => ({
      provider: r.provider,
      calls: r.calls,
      requests: r.audit,
    }));
    report.status = phase;
    save();
  };
  async function revalidate() {
    const [chain, nonce, code, operatorCode, balance, head] = await Promise.all(
      [
        read.chainId(),
        read.latestTransactionCount(account.address),
        read.code(account.address),
        read.code(OPERATOR),
        read.balance(account.address),
        read.request<Block>("eth_getBlockByNumber", ["latest", false]),
      ],
    );
    if (
      chain !== CHAIN ||
      nonce !== 0n ||
      code !== "0x" ||
      operatorCode !== "0x" ||
      (phase === "awaiting-approval" && balance !== 0n) ||
      Date.now() / 1000 - Number(BigInt(head.timestamp)) > 300 ||
      BigInt(head.baseFeePerGas) + review.mediaTips[0]! >
        review.mediaFees[0]! ||
      BigInt(head.baseFeePerGas) + review.cleanupTip > review.cleanupFee
    )
      throw new Error(
        "Reviewed chain/nonce/code/fees changed; no automatic plan increase",
      );
  }
  async function fund() {
    await session.financialRequest(
      "funding",
      account.address,
      review.fundingWei,
      async () => {
        await revalidate();
        permit.claimFunding(
          CHAIN,
          OPERATOR,
          account.address,
          review.fundingWei,
        );
      },
      () =>
        new Promise<Hex>((resolveHash, rejectHash) => {
          resolveFunding = resolveHash;
          rejectFunding = rejectHash;
          phase = "wallet-funding-requested";
          persistSession();
          console.log(
            json({
              action: "MANUAL WALLET FUNDING ONCE, only after user approval",
              from: OPERATOR,
              to: account.address,
              chainId: CHAIN,
              valueWei: review.fundingWei,
              gas: review.fundingGas,
              maxFeePerGas: review.fundingFeeCap,
              maxPriorityFeePerGas: review.fundingTip,
              notice:
                "Use normal wallet transfer; verify account/chain. Do not send media here. Enter funding <hash> or unknown; never retry an uncertain transfer.",
            }),
          );
        }),
    );
    await checkFunding();
  }
  async function checkFunding() {
    const hash = session.financial[0]!.hash!;
    fundingLedger.observe(await observeFunding(read, hash, account.address));
    session.financialFees.set(
      "funding",
      fundingLedger.observation!.operatorGas,
    );
    if (!fundingLedger.ready) {
      phase = "funding-review-required";
      session.held = true;
      busy = false;
      persistSession();
      console.log(
        "Observed funding differs from reviewed funding. Budget unchanged. Explicit recognition or separate pre-media cancellation review required.",
      );
      return;
    }
    const tx = await read.transaction(hash);
    if (
      !tx?.gas ||
      !tx.maxFeePerGas ||
      BigInt(tx.gas) > review.fundingGas ||
      BigInt(tx.maxFeePerGas) > review.fundingFeeCap
    )
      throw new Error(
        "Wallet funding caps not within approved envelope; do not start media",
      );
    await revalidate();
    if ((await read.balance(account.address)) < review.fundingWei)
      throw new Error("Funding balance insufficient");
    // Original financial request remains intact; observed actual value is in its own ledger.
    permit.confirmObservedFunding(session, fundingLedger);
    session.held = false;
    phase = "funded-not-started";
    busy = false;
    persistSession();
    console.log(
      "Funding verified. No media signed. Explicit start is required.",
    );
  }
  const hints: Hint[] = [];
  const digest = new Map<Hex, Hex>();
  const sentAt = new Map<Hex, number>();
  const replacedAt = new Map<Hex, number>();
  function lookup(hint: Hint, phase: string) {
    for (const child of children) child.send({ kind: "lookup", hint, phase });
  }
  async function readers() {
    for (const provider of PROVIDERS) {
      const child = fork(
        fileURLToPath(new URL("./reader.ts", import.meta.url)),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      children.push(child);
      child.on("message", (m: Record<string, unknown>) => {
        if (m.kind !== "observation") return;
        const hash = m.hash as Hex;
        const row = {
          ...m,
          atMs: now(),
          digestMatches:
            m.digest === undefined ? null : m.digest === digest.get(hash),
          sendStartedAt: sentAt.get(hash),
        };
        const observations = report.observations as unknown[];
        if (observations.length < 120) observations.push(row);
        save();
      });
      await new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Reader startup timeout")),
          5000,
        );
        child.once("error", () => {
          clearTimeout(timeout);
          reject(new Error("Reader unavailable"));
        });
        child.once("message", (m) => {
          clearTimeout(timeout);
          if ((m as { kind: string }).kind === "ready") resolveReady();
          else reject(new Error("Reader handshake failed"));
        });
        child.send({
          kind: "init",
          provider,
          context: {
            chainId: CHAIN,
            sessionAddress: account.address,
            streamId,
            nonce: 1,
            capacity: 5,
          },
        });
      });
    }
  }
  async function execute() {
    if (phase !== "funded-not-started" || busy)
      throw new Error("Session not ready or already started");
    busy = true;
    phase = "running";
    await revalidate();
    await readers();
    const start = performance.now();
    for (let i = 0; i < CAPACITY; i++) {
      await delay(Math.max(0, start + i * CADENCE - performance.now()));
      if (performance.now() - (start + i * CADENCE) > 750)
        throw new Error("Send cadence missed; no burst/catch-up");
      const raw = await session.sign("media", mediaTx(review, i), i);
      persistSession(); // inventory on disk is metadata only and precedes send
      const hash = keccak256(raw),
        hint: Hint = {
          version: 1,
          chainId: CHAIN,
          sessionAddress: account.address,
          streamId,
          sequence: i,
          transactionHash: hash,
        };
      hints.push(hint);
      digest.set(hash, keccak256(packet(streamId, i)));
      const started = now();
      sentAt.set(hash, started);
      if (i > 0) replacedAt.set(hints[i - 1]!.transactionHash, started);
      (report.candidates as unknown[]).push({
        hash,
        sequence: i,
        nonce: 1,
        replacementIndex: i,
        maxFee: review.mediaFees[i],
        tip: review.mediaTips[i],
        sendStartedAt: started,
      });
      // Hints can precede response; only the real RPC supplies transaction bytes.
      const sending = session.send(raw);
      lookup(hint, "current");
      if (i > 0) lookup(hints[i - 1]!, "after-replacement");
      await sending;
      persistSession();
    }
    await delay(Math.max(0, start + CAPACITY * CADENCE - performance.now()));
    const freeze = now();
    replacedAt.set(hints.at(-1)!.transactionHash, freeze);
    event("freeze", { at: freeze });
    await closeByHash(
      session,
      async (hash) => {
        for (let i = 0; i < 6; i++) {
          const t = await read.request<unknown>("eth_getTransactionByHash", [
            hash,
          ]);
          if (t) return t;
          await delay(400);
        }
        return null;
      },
      (hash) => event("seal-validated-by-hash-same-service", { hash }),
    );
    persistSession();
    await session.reconcile(30);
    event("classic-close-canonical");
    for (const hint of hints) lookup(hint, "after-close");
    const sweep = await session.sweep();
    persistSession();
    if (sweep) await session.confirmSweep(30);
    phase = sweep
      ? "reconciled-finality-pending"
      : "held-no-transferable-value";
    persistSession();
    const gas = [...session.receipts.values()].map(classicReceiptFee);
    const gasWei = gas.every((x) => x !== null)
      ? gas.reduce<bigint>((sum, x) => sum + x, 0n)
      : null;
    report.accounting = {
      fundingWei: fundingLedger.observation?.value ?? null,
      sessionGasWei: gasWei,
      returnedWei: session.returned,
      residualWei: session.residual,
      operatorFundingGasWei: session.financialFees.get("funding") ?? null,
      reconciles:
        gasWei !== null &&
        session.returned !== null &&
        session.residual !== null
          ? fundingLedger.observation?.value ===
            gasWei + session.returned + session.residual
          : null,
    };
    // Bounded finality reads, never a block-building or resend mechanism.
    const finalized = await read.request<Block>("eth_getBlockByNumber", [
      "finalized",
      false,
    ]);
    report.finality = {
      referenceBlock: finalized.number,
      referenceHash: finalized.hash,
      receipts: [...session.receipts.values()].map((r) => ({
        hash: r.transactionHash,
        finalized: BigInt(r.blockNumber) <= BigInt(finalized.number),
      })),
    };
    await delay(800); // only allows already-issued bounded post-close reads to return; not media ACK/dwell
    const observations = report.observations as {
      hash: Hex;
      provider: string;
      outcome: string;
      digestMatches: boolean;
      atMs: number;
      phase: string;
    }[];
    report.matrix = PROVIDERS.map((provider) => ({
      sender: "chainstack",
      reader: provider,
      candidates: hints.map((h) => {
        const valid = observations.find(
          (o) =>
            o.provider === provider &&
            o.hash === h.transactionHash &&
            o.outcome === "validated-pending" &&
            o.digestMatches,
        );
        const end = replacedAt.get(h.transactionHash)!;
        return {
          hash: h.transactionHash,
          sequence: h.sequence,
          firstValidAt: valid?.atMs ?? null,
          windowEndAt: end,
          recoveredInWindow: !!valid && valid.atMs < end,
          marginMs: valid ? end - valid.atMs : null,
          observations: observations.filter(
            (o) => o.provider === provider && o.hash === h.transactionHash,
          ),
        };
      }),
    }));
    report.verdict =
      "B3 PARTIAL — review measured windows, finality and any media inclusion before further activity";
    save();
    console.log(
      `Reconciled evidence: ${output}. No automatic second session. Finality may still be pending.`,
    );
  }
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  lines.on("line", (line) => {
    const [command, arg, amount] = line.trim().split(/\s+/);
    if (command === "status") {
      persistSession();
      console.log(
        json({
          phase,
          reviewId: reviewId(review),
          session: account.address,
          signatures: session.signatures.length,
          cancellation: cancellation.record,
          busy,
          signatureAttempted: permit.signatureAttempted,
          publicSends: report.publicSends,
          output,
        }),
      );
      return;
    }
    if (
      command === "funding" &&
      resolveFunding &&
      /^0x[0-9a-f]{64}$/i.test(arg ?? "")
    ) {
      const callback = resolveFunding;
      resolveFunding = undefined;
      rejectFunding = undefined;
      callback(arg as Hex);
      return;
    }
    if (command === "unknown" && rejectFunding) {
      const callback = rejectFunding;
      resolveFunding = undefined;
      rejectFunding = undefined;
      callback(new Error("Wallet outcome uncertain"));
      return;
    }
    void (async () => {
      if (command === "approve" && phase === "awaiting-approval" && !busy) {
        permit.approve(arg ?? "", amount ?? "");
        busy = true;
        await fund();
      } else if (command === "start") await execute();
      else if (
        command === "recognize" &&
        !busy &&
        phase === "funding-review-required"
      ) {
        busy = true;
        fundingLedger.recognize(arg ?? "", amount ?? "");
        await checkFunding();
      } else if (command === "cancel-review" && !busy) {
        busy = true;
        const hash = session.financial.find((f) => f.role === "funding")?.hash;
        if (!hash) throw new Error("Exact funding hash required");
        const quote = await cancellation.quote(hash);
        report.cancellationQuote = quote;
        persistSession();
        console.log(
          json({
            cancellationId: cancellationId(quote),
            quote,
            approval: "Separate cancellation approval required; nothing signed",
          }),
        );
        busy = false;
      } else if (command === "cancel" && !busy) {
        busy = true;
        await cancellation.execute(arg ?? "", amount ?? "");
        phase = "cancellation-pending";
        persistSession();
        busy = false;
      } else if (command === "reconcile" && !busy) {
        busy = true;
        try {
          if (cancellation.claimed) {
            report.cancellationResult = await cancellation.reconcile();
          } else if (session.signatures.some((s) => s.role === "sweep"))
            await session.confirmSweep();
          else if (session.frozen) await session.reconcile();
          else if (session.financial[0]?.hash) await checkFunding();
          else
            throw new Error("No exact financial hash; no transaction invented");
          persistSession();
          console.log(
            "Read-only evidence updated. No signing or sends triggered.",
          );
        } finally {
          busy = false;
        }
      } else console.log("Command unavailable; no action taken.");
    })().catch((e) => {
      busy = false;
      // Funding discrepancy is not exposure. Never undo an existing freeze.
      if (
        permit.signatureAttempted ||
        cancellation.claimed ||
        session.signatures.length
      )
        session.freeze();
      session.held = true;
      fail(
        `${phase}: ${e instanceof RpcFailure ? e.message : e instanceof Error ? e.name : "Unknown operation outcome"}`,
      );
      persistSession();
    });
  });
  // Retain memory if terminal disconnects; never auto-destroy an uncertain key.
  const keepAlive = setInterval(() => {}, 60_000);
  process.on("SIGINT", () => {
    if (permit.fundingClaimed && phase !== "reconciled-finality-pending") {
      console.log(
        "Retained session: process not stopped. Reconcile and review before manual shutdown.",
      );
      return;
    }
    persistSession();
    for (const child of children) child.kill();
    clearInterval(keepAlive);
    lines.close();
    process.exit(0);
  });
}
void main().catch((e) => {
  report.status = "preparation-blocked-no-signature";
  report.rpcAudit = rpcs.map((r) => ({
    provider: r.provider,
    calls: r.calls,
    requests: r.audit,
  }));
  report.reason = e instanceof Error ? e.message : "preparation error";
  save();
  console.log(
    json({ status: report.status, reason: report.reason, reportPath: output }),
  );
  process.exitCode = 1;
});

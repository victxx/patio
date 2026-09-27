"use client";

import {
  classifyAccountCode,
  getEoaReplacementEligibility,
  type EoaOperation,
  type Eip7702Operation,
  type Erc4337Operation,
  type EoaReplacementPlan,
  type KnownOperation,
  type ReplacementEligibility,
  type WalletCallBatchRecord,
} from "@patio/wallet-core";
import { patioNetworkByChainId } from "@patio/config";
import { useEffect, useMemo, useState } from "react";

import {
  executeReviewedEoaReplacement,
  prepareEoaReplacement,
  replacementNetworkFor,
} from "../lib/eoa-replacement";
import { BrowserEthereumRpc } from "../lib/direct-hoodi";
import {
  networkRuntimeById,
  patioNetworkRuntimeConfigs,
} from "../lib/network-runtime";
import type { ConnectedWallet } from "../lib/wallet";
import { WalletCallCapabilities } from "./wallet-call-capabilities";

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function eoaEligibilityKey(operation: EoaOperation): string {
  return operation.id;
}

function accountKindFromCode(
  code: string,
): "plain-eoa" | "eip7702-delegated" | "code-bearing" | "unknown" {
  const classification = classifyAccountCode(code);
  if (classification.kind === "no-code") return "plain-eoa";
  if (classification.kind === "eip7702-delegation") return "eip7702-delegated";
  return classification.kind === "contract-code" ? "code-bearing" : "unknown";
}

function feeLine(plan: EoaReplacementPlan): string {
  if (plan.gasPriceWei !== undefined)
    return `Gas price ${plan.gasPriceWei.toString()} wei`;
  return `Fee cap ${plan.maxFeePerGasWei?.toString() ?? "—"} wei · priority ${plan.maxPriorityFeePerGasWei?.toString() ?? "—"} wei`;
}

export function WalletOperationsPanel({
  wallet,
  networkName,
  selectedChainId,
  operations,
  callBatches,
  onClose,
  onChange,
}: {
  wallet: ConnectedWallet;
  networkName: string;
  selectedChainId: number;
  operations: readonly KnownOperation[];
  callBatches: readonly WalletCallBatchRecord[];
  onClose: () => void;
  onChange: () => void;
}) {
  const [eligibility, setEligibility] = useState<
    Record<string, ReplacementEligibility>
  >({});
  const [review, setReview] = useState<{
    operation: EoaOperation;
    plan: EoaReplacementPlan;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canonicalExecution, setCanonicalExecution] = useState<ReturnType<
    typeof classifyAccountCode
  > | null>(null);

  const candidates = useMemo(
    () =>
      operations.filter(
        (operation): operation is EoaOperation =>
          operation.executionType === "eoa" &&
          operation.control === "wallet-manageable",
      ),
    [operations],
  );

  useEffect(() => {
    let active = true;
    void Promise.all(
      candidates.map(async (operation) => {
        const profile = patioNetworkByChainId(operation.chainId);
        const runtime = profile
          ? networkRuntimeById(patioNetworkRuntimeConfigs(), profile.id)
          : undefined;
        if (!profile || !runtime?.relayRpc.url) {
          return [
            operation.id,
            { allowed: false, reason: "Replacement RPC is unavailable." },
          ] as const;
        }
        const rpc = new BrowserEthereumRpc(runtime.relayRpc);
        let kind:
          "plain-eoa" | "eip7702-delegated" | "code-bearing" | "unknown" =
          "unknown";
        try {
          kind = accountKindFromCode(
            await rpc.request<string>("eth_getCode", [
              operation.from,
              "latest",
            ]),
          );
        } catch {
          // Unknown is intentionally read-only.
        }
        const result = getEoaReplacementEligibility(operation, {
          connectedAddress: wallet.address,
          connectedChainId: profile.chainId,
          network: replacementNetworkFor(profile),
          accountKind: kind,
        });
        return [operation.id, result.speedUp] as const;
      }),
    ).then((items) => {
      if (!active) return;
      setEligibility(Object.fromEntries(items));
    });
    return () => {
      active = false;
    };
  }, [candidates, wallet.address]);

  useEffect(() => {
    let active = true;
    void wallet.provider
      .request({ method: "eth_getCode", params: [wallet.address, "latest"] })
      .then((code) => {
        if (active && typeof code === "string") {
          setCanonicalExecution(classifyAccountCode(code));
        }
      })
      .catch(() => {
        if (active) setCanonicalExecution(null);
      });
    return () => {
      active = false;
    };
  }, [wallet.address, wallet.provider]);

  const start = async (
    operation: EoaOperation,
    action: "speed-up" | "cancel",
  ) => {
    const profile = patioNetworkByChainId(operation.chainId);
    const runtime = profile
      ? networkRuntimeById(patioNetworkRuntimeConfigs(), profile.id)
      : undefined;
    if (!profile || !runtime?.relayRpc.url) {
      setMessage("Replacement RPC is unavailable for this network.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const [chainValue, accounts] = await Promise.all([
        wallet.provider.request({ method: "eth_chainId" }),
        wallet.provider.request({ method: "eth_accounts" }),
      ]);
      const connectedChainId = Number(BigInt(String(chainValue)));
      if (
        connectedChainId !== profile.chainId ||
        !Array.isArray(accounts) ||
        !accounts.some(
          (account) =>
            typeof account === "string" &&
            account.toLowerCase() === operation.from.toLowerCase(),
        )
      ) {
        throw new Error(
          "Connect the original wallet on this transaction's network.",
        );
      }
      const plan = await prepareEoaReplacement({
        action,
        operation,
        connectedAddress: wallet.address,
        connectedChainId,
        networkProfile: profile,
        rpc: new BrowserEthereumRpc(runtime.relayRpc),
      });
      setReview({ operation, plan });
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Replacement is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!review) return;
    const profile = patioNetworkByChainId(review.operation.chainId);
    const runtime = profile
      ? networkRuntimeById(patioNetworkRuntimeConfigs(), profile.id)
      : undefined;
    if (!profile || !runtime?.relayRpc.url) return;
    setBusy(true);
    setMessage(null);
    try {
      await executeReviewedEoaReplacement({
        plan: review.plan,
        operation: review.operation,
        connectedAddress: wallet.address,
        connectedChainId: profile.chainId,
        networkProfile: profile,
        rpc: new BrowserEthereumRpc(runtime.relayRpc),
        wallet: wallet.provider,
        storage: localStorage,
      });
      setReview(null);
      onChange();
      setMessage(
        "Replacement candidate submitted and verified against the reviewed plan.",
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Replacement was not submitted.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="wallet-history-panel"
      role="dialog"
      aria-label="Wallet activity"
    >
      <header className="wallet-history-panel__header">
        <div>
          <span>Known operations</span>
          <h2>Activity</h2>
        </div>
        <button type="button" aria-label="Close activity" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="wallet-history-empty">
        Account execution ·{" "}
        {canonicalExecution?.kind === "eip7702-delegation"
          ? `Delegation active → ${shortHash(canonicalExecution.delegate)}`
          : canonicalExecution?.kind === "no-code"
            ? "No delegation detected"
            : canonicalExecution?.kind === "contract-code"
              ? "Code-bearing account (not identified as EIP-7702)"
              : canonicalExecution
                ? "Code-bearing account could not be classified"
                : "Canonical delegation state unavailable"}
      </p>
      <WalletCallCapabilities
        wallet={wallet}
        chainId={selectedChainId}
        networkName={networkName}
      />
      {operations.length === 0 ? (
        <p className="wallet-history-empty">
          Known wallet operations will appear here. Patio media remains in its
          separate proof lineage.
        </p>
      ) : (
        <div className="trace-history-list">
          {operations.map((operation) => (
            <article key={operation.id} className="trace-history-item">
              <div className="trace-history-item__top">
                <div>
                  <strong>{operation.label ?? operation.executionType}</strong>
                  <span>
                    {operation.executionType === "patio-broadcast"
                      ? "Managed by Patio Broadcast"
                      : operation.status}
                  </span>
                </div>
                <span>
                  {operation.executionType === "eoa"
                    ? shortHash(operation.hash)
                    : operation.executionType === "erc4337"
                      ? shortHash(operation.userOpHash)
                      : operation.executionType}
                </span>
              </div>
              {operation.executionType === "eoa" &&
              operation.control === "wallet-manageable" ? (
                eligibility[eoaEligibilityKey(operation)]?.allowed ? (
                  <div className="wallet-operation-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void start(operation, "speed-up")}
                    >
                      Speed Up
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void start(operation, "cancel")}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <p className="wallet-history-empty">
                    {eligibility[eoaEligibilityKey(operation)]?.reason ??
                      "Checking replacement eligibility…"}
                  </p>
                )
              ) : operation.executionType === "eoa" ? (
                <p className="wallet-history-empty">
                  Managed by Patio Broadcast
                </p>
              ) : operation.executionType === "eip7702" ? (
                <Eip7702OperationDetails
                  operation={operation}
                  canonicalExecution={canonicalExecution}
                />
              ) : operation.executionType === "erc4337" ? (
                <Erc4337OperationDetails operation={operation} />
              ) : null}
            </article>
          ))}
        </div>
      )}
      {callBatches.length > 0 ? (
        <div className="trace-history-list" aria-label="Wallet call batches">
          {callBatches.map((batch) => (
            <article key={batch.id} className="trace-history-item">
              <div className="trace-history-item__top">
                <div>
                  <strong>Wallet call batch</strong>
                  <span>{batch.state}</span>
                </div>
                <span>{batch.callCount} calls</span>
              </div>
              <p className="wallet-history-empty">
                Atomic requested ·{" "}
                {batch.atomicReported === undefined
                  ? "wallet status not reported"
                  : batch.atomicReported
                    ? "atomic reported"
                    : "non-atomic status reported"}
              </p>
              {batch.rawStatusCode !== undefined ? (
                <p className="wallet-history-empty">
                  Wallet status {batch.rawStatusCode}
                </p>
              ) : null}
              {batch.atomicityInconsistent ? (
                <p className="wallet-history-empty">
                  Reported outcome does not satisfy the requested atomic
                  guarantee.
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {message ? (
        <p className="wallet-history-empty" role="status">
          {message}
        </p>
      ) : null}
      {review ? (
        <div
          className="wallet-operation-review"
          role="dialog"
          aria-label={`${review.plan.action} transaction`}
        >
          <h3>
            {review.plan.action === "speed-up"
              ? "Speed up transaction"
              : "Cancel transaction"}
          </h3>
          <p>Nonce {review.plan.nonce.toString()}</p>
          <p>{feeLine(review.plan)}</p>
          <p>
            Maximum fee cap {review.plan.estimatedMaxCostWei.toString()} wei
          </p>
          {review.plan.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <div className="wallet-operation-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {review.plan.action === "speed-up"
                ? "Confirm Speed Up"
                : "Confirm Cancel"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Erc4337OperationDetails({
  operation,
}: {
  operation: Erc4337Operation;
}) {
  return (
    <div className="wallet-history-empty">
      <p>
        ERC-4337 UserOperation ·{" "}
        {operation.entryPointVersion === "0.7"
          ? "EntryPoint v0.7"
          : "legacy EntryPoint unknown"}
      </p>
      <p>
        Sender {shortHash(operation.sender)} · nonce{" "}
        {operation.nonce.toString()}
      </p>
      <p>
        {operation.operationState} · evidence {operation.evidence}
      </p>
      {operation.outerTransactionHash ? (
        <p>Outer transaction {shortHash(operation.outerTransactionHash)}</p>
      ) : null}
      {operation.actualGasCostWei !== undefined ? (
        <p>
          Attributed UserOperation gas cost{" "}
          {operation.actualGasCostWei.toString()} wei
        </p>
      ) : null}
      <p>
        Gas payer:{" "}
        {operation.gasPayment.kind === "self-paid"
          ? "self"
          : operation.gasPayment.status === "verified"
            ? `verified paymaster ${shortHash(operation.gasPayment.paymaster)}`
            : `proposed sponsor ${operation.gasPayment.sponsorId} (${operation.gasPayment.status})`}
      </p>
      <p>Read-only · EOA Speed Up and Cancel do not apply.</p>
    </div>
  );
}

function Eip7702OperationDetails({
  operation,
  canonicalExecution,
}: {
  operation: Eip7702Operation;
  canonicalExecution: ReturnType<typeof classifyAccountCode> | null;
}) {
  const delegates = operation.authorizations.map(
    (authorization) => authorization.delegate,
  );
  const capability = patioNetworkByChainId(operation.chainId)
    ?.accountExecutionCapabilities.eip7702;
  return (
    <div className="wallet-history-empty">
      <p>EIP-7702 transaction · outer sender {shortHash(operation.from)}</p>
      <p>
        Nonce {operation.nonce.toString()} · authorizations{" "}
        {operation.authorizationCount}
      </p>
      {delegates.length > 0 ? (
        <p>
          Pending delegate{delegates.length === 1 ? "" : "s"}:{" "}
          {delegates.map(shortHash).join(", ")}
        </p>
      ) : (
        <p>Authorization metadata {operation.authorizationMetadata}.</p>
      )}
      <p>
        A pending authorization does not prove an active canonical delegation.
        {canonicalExecution?.kind === "eip7702-delegation"
          ? ` Current canonical delegate: ${shortHash(canonicalExecution.delegate)}.`
          : " Current canonical delegation is not active or unavailable."}
      </p>
      <p>EIP-7702 network capability: {capability?.status ?? "unknown"}.</p>
    </div>
  );
}

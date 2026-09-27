"use client";

import { PATIO_NETWORK_PROFILES, patioNetworkByChainId } from "@patio/config";
import { formatEther } from "viem";

import type { BroadcastHistoryEntry } from "../lib/broadcast-history";

function shortHex(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function entryProfile(entry: BroadcastHistoryEntry) {
  return (
    (entry.chainId ? patioNetworkByChainId(entry.chainId) : undefined) ??
    PATIO_NETWORK_PROFILES.hoodi
  );
}

function formatFee(
  wei: string | undefined,
  entry: BroadcastHistoryEntry,
): string {
  if (wei === undefined) return "Unknown";
  const symbol =
    entry.nativeCurrencySymbol ?? entryProfile(entry).nativeCurrency.symbol;
  return `${formatEther(BigInt(wei))} ${symbol}`;
}

export function WalletHistoryPanel({
  history,
  onClose,
}: {
  history: BroadcastHistoryEntry[];
  onClose: () => void;
}) {
  return (
    <section
      className="wallet-history-panel"
      role="dialog"
      aria-label="Broadcast history"
    >
      <header className="wallet-history-panel__header">
        <div>
          <span>Local archive</span>
          <h2>History</h2>
        </div>
        <button type="button" aria-label="Close history" onClick={onClose}>
          ×
        </button>
      </header>

      {history.length === 0 ? (
        <p className="wallet-history-empty">
          Completed broadcasts will appear here with duration, gas and network
          receipts.
        </p>
      ) : (
        <div className="trace-history-list">
          {history.map((entry) => (
            <article key={entry.id} className="trace-history-item">
              <div className="trace-history-item__top">
                <div>
                  <strong>
                    {entry.mediaMode === "video"
                      ? "Video"
                      : entry.mediaMode === "video-beta"
                        ? "Video beta"
                        : "Audio"}
                  </strong>
                  <span>{new Date(entry.completedAt).toLocaleString()}</span>
                </div>
                <span>
                  {entry.totalFeeWei === undefined
                    ? "setup cost unknown"
                    : formatFee(entry.totalFeeWei, entry)}
                </span>
              </div>
              <dl className="trace-values">
                <div>
                  <dt>duration</dt>
                  <dd>{entry.actualSeconds}s</dd>
                </div>
                <div>
                  <dt>packets / windows</dt>
                  <dd>
                    {entry.packetCount} / {entry.windowCount}
                  </dd>
                </div>
                <div>
                  <dt>temporary exposure</dt>
                  <dd>{formatFee(entry.temporaryExposureWei, entry)}</dd>
                </div>
                <div>
                  <dt>returned by sweep</dt>
                  <dd>{formatFee(entry.returnedWei, entry)}</dd>
                </div>
                <div>
                  <dt>registry gas</dt>
                  <dd>{formatFee(entry.registryFeeWei, entry)}</dd>
                </div>
                <div>
                  <dt>funding gas</dt>
                  <dd>
                    {entry.fundingFeeWei === undefined
                      ? "unknown (shared wallet batch)"
                      : formatFee(entry.fundingFeeWei, entry)}
                  </dd>
                </div>
                <div>
                  <dt>cleanup gas</dt>
                  <dd>{formatFee(entry.cleanupFeeWei, entry)}</dd>
                </div>
                {entry.mediaIncludedHashes ? (
                  <>
                    <div>
                      <dt>known media included</dt>
                      <dd>
                        {entry.mediaIncludedHashes.length}
                        {entry.mediaIncludedHashes.length
                          ? " — inclusion incident"
                          : " — checked receipts only"}
                      </dd>
                    </div>
                    <div>
                      <dt>included media gas</dt>
                      <dd>{formatFee(entry.mediaGasWei, entry)}</dd>
                    </div>
                    <div>
                      <dt>observed residual</dt>
                      <dd>{formatFee(entry.residualWei, entry)}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              <a href={entry.listenerUrl}>Open session link</a>
              <details className="trace-history-transactions">
                <summary>
                  {entry.transactionHashes.length} {entryProfile(entry).name}{" "}
                  receipts
                </summary>
                <ul>
                  {entry.transactionHashes.map((hash, index) => (
                    <li key={hash}>
                      <a
                        href={`${entryProfile(entry).explorerBaseUrl}/tx/${hash}`}
                        target="_blank"
                        rel="noreferrer"
                        title={hash}
                      >
                        transaction {index + 1} · {shortHex(hash)}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

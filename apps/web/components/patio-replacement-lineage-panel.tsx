"use client";

import { formatGwei } from "viem";

import type { PatioNetworkProfile } from "@patio/config";

import type {
  PatioReplacementCandidate,
  PatioReplacementLineage,
} from "../lib/patio-replacement-lineage";

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function candidateLabel(candidate: PatioReplacementCandidate): string {
  if (candidate.kind === "media") {
    return `packet ${candidate.sequence ?? "?"} · replacement ${candidate.replacementIndex ?? "?"}`;
  }
  return candidate.kind === "seal" ? "empty seal" : candidate.kind;
}

function outcome(candidate: PatioReplacementCandidate): string {
  if (candidate.lifecycle === "excluded-from-canonical-history") {
    return "not included in canonical history";
  }
  if (candidate.lifecycle === "superseded")
    return "superseded in Patio sequence";
  return candidate.lifecycle;
}

function CandidateRow({ candidate }: { candidate: PatioReplacementCandidate }) {
  return (
    <li className={`replacement-lineage__candidate is-${candidate.lifecycle}`}>
      <div>
        <strong>{candidateLabel(candidate)}</strong>
        <span title={candidate.hash}>{shortHash(candidate.hash)}</span>
      </div>
      <span>
        {formatGwei(candidate.maxFeePerGasWei)} gwei · observer{" "}
        {candidate.observerStatus}
      </span>
      <details>
        <summary>details</summary>
        <dl>
          <div>
            <dt>max fee</dt>
            <dd>{candidate.maxFeePerGasWei.toString()} wei</dd>
          </div>
          <div>
            <dt>priority fee</dt>
            <dd>{candidate.maxPriorityFeePerGasWei.toString()} wei</dd>
          </div>
          <div>
            <dt>submitted</dt>
            <dd>{new Date(candidate.submittedAtMs).toLocaleTimeString()}</dd>
          </div>
          <div>
            <dt>outcome</dt>
            <dd>{outcome(candidate)}</dd>
          </div>
          {candidate.replaces ? (
            <div>
              <dt>replaces</dt>
              <dd title={candidate.replaces}>
                {shortHash(candidate.replaces)}
              </dd>
            </div>
          ) : null}
          {candidate.replacedBy ? (
            <div>
              <dt>replaced by</dt>
              <dd title={candidate.replacedBy}>
                {shortHash(candidate.replacedBy)}
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </li>
  );
}

export function PatioReplacementLineagePanel({
  lineage,
  networkProfile,
}: {
  lineage: PatioReplacementLineage;
  networkProfile: PatioNetworkProfile;
}) {
  return (
    <details className="replacement-lineage">
      <summary>
        Replacement lineage
        <span>
          {lineage.windows.length} window
          {lineage.windows.length === 1 ? "" : "s"}
        </span>
      </summary>
      <p>
        {networkProfile.name} ·{" "}
        {networkProfile.canonicalSubmissionModel.replace("-", " ")} · transport{" "}
        {networkProfile.transportCapabilities.independentObservation.status}
      </p>
      {lineage.windows.length === 0 ? (
        <p className="replacement-lineage__empty">
          Candidates appear here after Patio submits a media replacement.
        </p>
      ) : (
        lineage.windows.map((window) => (
          <section key={`${window.windowIndex}-${window.nonce.toString()}`}>
            <h4>
              Window {window.windowIndex} · nonce {window.nonce.toString()}
            </h4>
            <ol>
              {window.candidates.map((candidate) => (
                <CandidateRow key={candidate.hash} candidate={candidate} />
              ))}
            </ol>
          </section>
        ))
      )}
      {lineage.cleanup.length > 0 ? (
        <section>
          <h4>Cleanup operations</h4>
          <ol>
            {lineage.cleanup.map((candidate) => (
              <CandidateRow key={candidate.hash} candidate={candidate} />
            ))}
          </ol>
        </section>
      ) : null}
      <p className="replacement-lineage__note">
        This is Patio&apos;s local record of replacements. It does not claim
        that earlier candidates disappeared from every mempool or archive.
      </p>
    </details>
  );
}

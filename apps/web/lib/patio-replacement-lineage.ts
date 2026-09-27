import { PATIO_DEFAULTS } from "@patio/config";
import type { Hex } from "viem";

export type PatioReplacementKind = "media" | "seal" | "release" | "sweep";
export type PatioObserverStatus = "waiting" | "observed" | "not-applicable";
export type PatioReplacementLifecycle =
  | "submitted"
  | "observed"
  | "superseded"
  | "included"
  | "excluded-from-canonical-history";

/** Metadata only. It deliberately contains neither calldata nor media bytes. */
export interface PatioReplacementCandidate {
  hash: Hex;
  nonce: bigint;
  windowIndex?: number;
  kind: PatioReplacementKind;
  sequence?: number;
  replacementIndex?: number;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  submittedAtMs: number;
  observerStatus: PatioObserverStatus;
  lifecycle: PatioReplacementLifecycle;
  replaces?: Hex;
  replacedBy?: Hex;
}

export interface PatioNonceWindowLineage {
  windowIndex: number;
  nonce: bigint;
  candidates: readonly PatioReplacementCandidate[];
}

export interface PatioReplacementLineage {
  windows: readonly PatioNonceWindowLineage[];
  cleanup: readonly PatioReplacementCandidate[];
  maximumCandidates: number;
}

export interface PatioReplacementLineageSummary {
  version: 1;
  mediaCandidateCount: number;
  nonceWindowCount: number;
  sealedWindowCount: number;
  includedSealHashes: string[];
  mediaExcludedFromCanonicalHistory: boolean;
}

interface CandidateInput {
  hash: Hex;
  nonce: bigint;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  submittedAtMs: number;
}

function candidateCount(lineage: PatioReplacementLineage): number {
  return (
    lineage.cleanup.length +
    lineage.windows.reduce(
      (total, window) => total + window.candidates.length,
      0,
    )
  );
}

function hasHash(lineage: PatioReplacementLineage, hash: Hex): boolean {
  return (
    lineage.cleanup.some((candidate) => candidate.hash === hash) ||
    lineage.windows.some((window) =>
      window.candidates.some((candidate) => candidate.hash === hash),
    )
  );
}

function updateCandidate(
  lineage: PatioReplacementLineage,
  hash: Hex,
  update: (candidate: PatioReplacementCandidate) => PatioReplacementCandidate,
): PatioReplacementLineage {
  let changed = false;
  const windows = lineage.windows.map((window) => {
    const candidates = window.candidates.map((candidate) => {
      if (candidate.hash !== hash) return candidate;
      changed = true;
      return update(candidate);
    });
    return candidates === window.candidates
      ? window
      : { ...window, candidates };
  });
  const cleanup = lineage.cleanup.map((candidate) => {
    if (candidate.hash !== hash) return candidate;
    changed = true;
    return update(candidate);
  });
  return changed ? { ...lineage, windows, cleanup } : lineage;
}

function appendWindowCandidate(
  lineage: PatioReplacementLineage,
  windowIndex: number,
  nonce: bigint,
  candidate: PatioReplacementCandidate,
): PatioReplacementLineage {
  const existingIndex = lineage.windows.findIndex(
    (window) => window.windowIndex === windowIndex,
  );
  if (existingIndex === -1) {
    if (lineage.windows.length >= PATIO_DEFAULTS.maxWindowsPerEpoch) {
      return lineage;
    }
    return {
      ...lineage,
      windows: [
        ...lineage.windows,
        { windowIndex, nonce, candidates: [candidate] },
      ],
    };
  }

  const window = lineage.windows[existingIndex]!;
  if (window.nonce !== nonce) return lineage;
  const windows = [...lineage.windows];
  windows[existingIndex] = {
    ...window,
    candidates: [...window.candidates, candidate],
  };
  return { ...lineage, windows };
}

function terminalSealExists(window: PatioNonceWindowLineage): boolean {
  return window.candidates.some((candidate) => candidate.kind === "seal");
}

export function createPatioReplacementLineage(
  maximumCandidates = PATIO_DEFAULTS.maxWindowsPerEpoch *
    (PATIO_DEFAULTS.maxReplacementsPerWindow + 1) +
    2,
): PatioReplacementLineage {
  return { windows: [], cleanup: [], maximumCandidates };
}

export function addMediaReplacementCandidate(
  lineage: PatioReplacementLineage,
  input: CandidateInput & {
    windowIndex: number;
    sequence: number;
    replacementIndex: number;
  },
): PatioReplacementLineage {
  if (
    candidateCount(lineage) >= lineage.maximumCandidates ||
    hasHash(lineage, input.hash)
  ) {
    return lineage;
  }

  const existing = lineage.windows.find(
    (window) => window.windowIndex === input.windowIndex,
  );
  if (existing) {
    if (
      existing.nonce !== input.nonce ||
      terminalSealExists(existing) ||
      input.replacementIndex !==
        existing.candidates.filter((candidate) => candidate.kind === "media")
          .length
    ) {
      return lineage;
    }
  } else if (input.replacementIndex !== 0) {
    return lineage;
  }

  const previous = existing?.candidates.at(-1);
  const candidate: PatioReplacementCandidate = {
    ...input,
    kind: "media",
    observerStatus: "waiting",
    lifecycle: "submitted",
    ...(previous ? { replaces: previous.hash } : {}),
  };
  const next = appendWindowCandidate(
    lineage,
    input.windowIndex,
    input.nonce,
    candidate,
  );
  if (next === lineage || !previous) return next;
  return updateCandidate(next, previous.hash, (current) => ({
    ...current,
    lifecycle: "superseded",
    replacedBy: candidate.hash,
  }));
}

export function addPatioEmptySealCandidate(
  lineage: PatioReplacementLineage,
  input: CandidateInput & { windowIndex: number },
): PatioReplacementLineage {
  if (
    candidateCount(lineage) >= lineage.maximumCandidates ||
    hasHash(lineage, input.hash)
  ) {
    return lineage;
  }
  const existing = lineage.windows.find(
    (window) => window.windowIndex === input.windowIndex,
  );
  if (
    existing &&
    (existing.nonce !== input.nonce || terminalSealExists(existing))
  ) {
    return lineage;
  }
  const previous = existing?.candidates.at(-1);
  const candidate: PatioReplacementCandidate = {
    ...input,
    kind: "seal",
    observerStatus: "waiting",
    lifecycle: "submitted",
    ...(previous ? { replaces: previous.hash } : {}),
  };
  const next = appendWindowCandidate(
    lineage,
    input.windowIndex,
    input.nonce,
    candidate,
  );
  if (next === lineage || !previous) return next;
  return updateCandidate(next, previous.hash, (current) => ({
    ...current,
    lifecycle: "superseded",
    replacedBy: candidate.hash,
  }));
}

export function addPatioCleanupCandidate(
  lineage: PatioReplacementLineage,
  input: CandidateInput & { kind: "release" | "sweep" },
): PatioReplacementLineage {
  if (
    candidateCount(lineage) >= lineage.maximumCandidates ||
    hasHash(lineage, input.hash)
  ) {
    return lineage;
  }
  return {
    ...lineage,
    cleanup: [
      ...lineage.cleanup,
      {
        ...input,
        observerStatus: "not-applicable",
        lifecycle: "submitted",
      },
    ],
  };
}

export function markPatioReplacementObserved(
  lineage: PatioReplacementLineage,
  hash: Hex,
): PatioReplacementLineage {
  return updateCandidate(lineage, hash, (candidate) => ({
    ...candidate,
    observerStatus: "observed",
    lifecycle:
      candidate.lifecycle === "superseded"
        ? "superseded"
        : candidate.lifecycle === "included"
          ? "included"
          : "observed",
  }));
}

export function markPatioReplacementIncluded(
  lineage: PatioReplacementLineage,
  hash: Hex,
): PatioReplacementLineage {
  return updateCandidate(lineage, hash, (candidate) => ({
    ...candidate,
    lifecycle: "included",
  }));
}

export function markPatioMediaExcludedFromCanonicalHistory(
  lineage: PatioReplacementLineage,
): PatioReplacementLineage {
  const windows = lineage.windows.map((window) => ({
    ...window,
    candidates: window.candidates.map((candidate) =>
      candidate.kind === "media" && candidate.lifecycle !== "included"
        ? {
            ...candidate,
            lifecycle: "excluded-from-canonical-history" as const,
          }
        : candidate,
    ),
  }));
  return { ...lineage, windows };
}

export function summarizePatioReplacementLineage(
  lineage: PatioReplacementLineage,
): PatioReplacementLineageSummary {
  const media = lineage.windows.flatMap((window) =>
    window.candidates.filter((candidate) => candidate.kind === "media"),
  );
  const includedSealHashes = lineage.windows.flatMap((window) =>
    window.candidates
      .filter(
        (candidate) =>
          candidate.kind === "seal" && candidate.lifecycle === "included",
      )
      .map((candidate) => candidate.hash),
  );
  return {
    version: 1,
    mediaCandidateCount: media.length,
    nonceWindowCount: lineage.windows.length,
    sealedWindowCount: lineage.windows.filter((window) =>
      window.candidates.some((candidate) => candidate.kind === "seal"),
    ).length,
    includedSealHashes,
    mediaExcludedFromCanonicalHistory:
      media.length > 0 &&
      media.every(
        (candidate) =>
          candidate.lifecycle === "excluded-from-canonical-history",
      ),
  };
}

/** Pure diagnostics for the local representation; never used to control transport. */
export function patioLineageInvariantViolations(
  lineage: PatioReplacementLineage,
): readonly string[] {
  const violations: string[] = [];
  const hashes = new Set<Hex>();
  for (const window of lineage.windows) {
    let expectedReplacementIndex = 0;
    let sealSeen = false;
    let previousMedia: PatioReplacementCandidate | null = null;
    for (const candidate of window.candidates) {
      if (candidate.nonce !== window.nonce) {
        violations.push(`window ${window.windowIndex} has mixed nonces`);
      }
      if (hashes.has(candidate.hash)) {
        violations.push(`duplicate candidate hash ${candidate.hash}`);
      }
      hashes.add(candidate.hash);
      if (candidate.kind === "seal") sealSeen = true;
      if (candidate.kind !== "media") continue;
      if (sealSeen) {
        violations.push(
          `window ${window.windowIndex} contains media after a seal`,
        );
      }
      if (candidate.replacementIndex !== expectedReplacementIndex) {
        violations.push(
          `window ${window.windowIndex} has non-monotonic replacement indices`,
        );
      }
      expectedReplacementIndex += 1;
      if (
        previousMedia &&
        (candidate.maxFeePerGasWei < previousMedia.maxFeePerGasWei ||
          candidate.maxPriorityFeePerGasWei <
            previousMedia.maxPriorityFeePerGasWei)
      ) {
        violations.push(`window ${window.windowIndex} has regressing fees`);
      }
      previousMedia = candidate;
    }
  }
  for (const candidate of lineage.cleanup) {
    if (candidate.kind !== "release" && candidate.kind !== "sweep") {
      violations.push(
        `cleanup contains non-cleanup candidate ${candidate.hash}`,
      );
    }
    if (hashes.has(candidate.hash)) {
      violations.push(`duplicate candidate hash ${candidate.hash}`);
    }
    hashes.add(candidate.hash);
  }
  return violations;
}

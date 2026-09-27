import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  addMediaReplacementCandidate,
  addPatioCleanupCandidate,
  addPatioEmptySealCandidate,
  createPatioReplacementLineage,
  markPatioMediaExcludedFromCanonicalHistory,
  markPatioReplacementIncluded,
  markPatioReplacementObserved,
  patioLineageInvariantViolations,
  summarizePatioReplacementLineage,
} from "./patio-replacement-lineage";

const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}`;

const media = (
  suffix: string,
  replacementIndex: number,
  nonce = 148n,
  windowIndex = 0,
) => ({
  hash: hash(suffix),
  nonce,
  windowIndex,
  sequence: replacementIndex,
  replacementIndex,
  maxFeePerGasWei: BigInt(1_000 + replacementIndex * 125),
  maxPriorityFeePerGasWei: 1_000n,
  submittedAtMs: 1_000 + replacementIndex,
});

describe("Patio replacement lineage", () => {
  it("creates a window lineage from its first media candidate", () => {
    const lineage = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    expect(lineage.windows).toHaveLength(1);
    expect(lineage.windows[0]?.nonce).toBe(148n);
    expect(lineage.windows[0]?.candidates[0]).toMatchObject({
      kind: "media",
      observerStatus: "waiting",
      lifecycle: "submitted",
    });
  });

  it("links same-nonce replacements with recorded fee progression", () => {
    const first = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    const lineage = addMediaReplacementCandidate(first, media("2", 1));
    const [firstCandidate, secondCandidate] = lineage.windows[0]!.candidates;
    expect(firstCandidate).toMatchObject({
      lifecycle: "superseded",
      replacedBy: hash("2"),
    });
    expect(secondCandidate).toMatchObject({
      replaces: hash("1"),
      replacementIndex: 1,
      maxFeePerGasWei: 1_125n,
    });
  });

  it("creates separate lineage windows for different nonces", () => {
    const first = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    const lineage = addMediaReplacementCandidate(first, media("2", 0, 149n, 1));
    expect(lineage.windows).toHaveLength(2);
    expect(lineage.windows.map((window) => window.nonce)).toEqual([148n, 149n]);
  });

  it("updates observer state only for an already-known hash", () => {
    const first = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    expect(markPatioReplacementObserved(first, hash("not-known"))).toBe(first);
    const lineage = markPatioReplacementObserved(first, hash("1"));
    expect(lineage.windows[0]?.candidates[0]).toMatchObject({
      observerStatus: "observed",
      lifecycle: "observed",
    });
  });

  it("keeps a superseded candidate superseded when observer updates arrive late", () => {
    const lineage = addMediaReplacementCandidate(
      addMediaReplacementCandidate(
        createPatioReplacementLineage(),
        media("1", 0),
      ),
      media("2", 1),
    );
    const updated = markPatioReplacementObserved(lineage, hash("1"));
    expect(updated.windows[0]?.candidates[0]).toMatchObject({
      observerStatus: "observed",
      lifecycle: "superseded",
    });
    expect(updated.windows[0]?.candidates[1]).toMatchObject({
      observerStatus: "waiting",
      lifecycle: "submitted",
    });
  });

  it("makes an empty seal replace the final media candidate and terminalize the nonce", () => {
    const second = addMediaReplacementCandidate(
      addMediaReplacementCandidate(
        createPatioReplacementLineage(),
        media("1", 0),
      ),
      media("2", 1),
    );
    const sealed = addPatioEmptySealCandidate(second, {
      hash: hash("seal"),
      nonce: 148n,
      windowIndex: 0,
      maxFeePerGasWei: 1_300n,
      maxPriorityFeePerGasWei: 1_100n,
      submittedAtMs: 2_000,
    });
    const candidates = sealed.windows[0]!.candidates;
    expect(candidates.at(-1)).toMatchObject({
      kind: "seal",
      replaces: hash("2"),
    });
    expect(candidates.at(-2)).toMatchObject({
      lifecycle: "superseded",
      replacedBy: hash("seal"),
    });
    expect(addMediaReplacementCandidate(sealed, media("3", 2))).toBe(sealed);
  });

  it("records canonical inclusion and excludes only media after cleanup evidence", () => {
    const mediaLineage = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    const sealed = addPatioEmptySealCandidate(mediaLineage, {
      hash: hash("seal"),
      nonce: 148n,
      windowIndex: 0,
      maxFeePerGasWei: 1_300n,
      maxPriorityFeePerGasWei: 1_100n,
      submittedAtMs: 2_000,
    });
    const included = markPatioReplacementIncluded(sealed, hash("seal"));
    const final = markPatioMediaExcludedFromCanonicalHistory(included);
    expect(final.windows[0]!.candidates[0]?.lifecycle).toBe(
      "excluded-from-canonical-history",
    );
    expect(final.windows[0]!.candidates[1]?.lifecycle).toBe("included");
    expect(summarizePatioReplacementLineage(final)).toMatchObject({
      mediaCandidateCount: 1,
      sealedWindowCount: 1,
      includedSealHashes: [hash("seal")],
      mediaExcludedFromCanonicalHistory: true,
    });
  });

  it("rejects duplicate hashes deterministically and keeps cleanup separate", () => {
    const first = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    expect(addMediaReplacementCandidate(first, media("1", 0))).toBe(first);
    const cleanup = addPatioCleanupCandidate(first, {
      kind: "release",
      hash: hash("release"),
      nonce: 147n,
      maxFeePerGasWei: 1_300n,
      maxPriorityFeePerGasWei: 1_100n,
      submittedAtMs: 3_000,
    });
    expect(cleanup.cleanup[0]).toMatchObject({
      kind: "release",
      nonce: 147n,
      observerStatus: "not-applicable",
    });
  });

  it("stores metadata only", () => {
    const lineage = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    const serialized = JSON.stringify(
      lineage,
      (_key: string, value: unknown): unknown =>
        typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toMatch(/payload|calldata|rawTransaction|signed/i);
  });

  it("has no signing or transaction-submission action surface", () => {
    const lineage = addMediaReplacementCandidate(
      createPatioReplacementLineage(),
      media("1", 0),
    );
    const candidate = lineage.windows[0]!.candidates[0]!;
    expect(
      Object.values(candidate).some((value) => typeof value === "function"),
    ).toBe(false);
    expect(Object.keys(candidate)).not.toEqual(
      expect.arrayContaining(["sign", "send", "rawTransaction"]),
    );
  });

  it("reports corrupt local lineage without using it to control transport", () => {
    const valid = addMediaReplacementCandidate(
      addMediaReplacementCandidate(
        createPatioReplacementLineage(),
        media("1", 0),
      ),
      media("2", 1),
    );
    expect(patioLineageInvariantViolations(valid)).toEqual([]);

    const [first, second] = valid.windows[0]!.candidates;
    const corrupted = {
      ...valid,
      windows: [
        {
          ...valid.windows[0]!,
          candidates: [
            first!,
            {
              ...second!,
              nonce: 149n,
              replacementIndex: 3,
              maxFeePerGasWei: 1n,
            },
          ],
        },
      ],
    };

    expect(patioLineageInvariantViolations(corrupted)).toEqual(
      expect.arrayContaining([
        "window 0 has mixed nonces",
        "window 0 has non-monotonic replacement indices",
        "window 0 has regressing fees",
      ]),
    );
  });
});

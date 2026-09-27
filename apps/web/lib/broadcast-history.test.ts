import { describe, expect, it } from "vitest";

import {
  appendBroadcastHistory,
  BROADCAST_HISTORY_STORAGE_KEY,
  loadBroadcastHistory,
  type BroadcastHistoryEntry,
} from "./broadcast-history";

function entry(id: string): BroadcastHistoryEntry {
  return {
    version: 1,
    id,
    completedAt: "2026-09-11T00:00:00.000Z",
    mediaMode: "audio",
    visibility: "unlisted",
    actualSeconds: 42,
    plannedSeconds: 42,
    packetCount: 14,
    windowCount: 2,
    sessionAddress: "0xsession",
    operator: "0xoperator",
    listenerUrl: "https://example.com/?station=0xsession",
    fundingFeeWei: "1",
    cleanupFeeWei: "2",
    totalFeeWei: "3",
    transactionHashes: ["0xhash"],
  };
}

describe("broadcast history", () => {
  it("persists newest entries first and deduplicates by id", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    appendBroadcastHistory(storage, entry("one"));
    appendBroadcastHistory(storage, entry("two"));
    appendBroadcastHistory(storage, entry("one"));
    expect(loadBroadcastHistory(storage).map((item) => item.id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("ignores corrupt storage", () => {
    const storage = { getItem: () => "not-json" };
    expect(loadBroadcastHistory(storage)).toEqual([]);
  });

  it("retains real-video history entries", () => {
    const video = { ...entry("video"), mediaMode: "video" as const };
    const storage = {
      getItem: () => JSON.stringify([video]),
    };
    expect(loadBroadcastHistory(storage)).toEqual([video]);
  });

  it("keeps legacy entries valid while accepting a compact lineage summary", () => {
    const legacy = entry("legacy");
    const withLineage = {
      ...entry("lineage"),
      lineageSummary: {
        version: 1 as const,
        mediaCandidateCount: 5,
        nonceWindowCount: 1,
        sealedWindowCount: 1,
        includedSealHashes: ["0xseal"],
        mediaExcludedFromCanonicalHistory: true,
      },
    };
    const storage = { getItem: () => JSON.stringify([legacy, withLineage]) };
    expect(loadBroadcastHistory(storage)).toEqual([legacy, withLineage]);
  });

  it("retains an atomic setup history entry without inventing per-call fees", () => {
    const {
      fundingFeeWei: _fundingFeeWei,
      totalFeeWei: _totalFeeWei,
      ...atomic
    } = {
      ...entry("atomic"),
      transactionHashes: ["0xshared-receipt"],
    };
    const storage = { getItem: () => JSON.stringify([atomic]) };
    expect(loadBroadcastHistory(storage)).toEqual([atomic]);
  });

  it("caps the local audit log", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    for (let index = 0; index < 25; index += 1) {
      appendBroadcastHistory(storage, entry(String(index)));
    }
    expect(
      JSON.parse(values.get(BROADCAST_HISTORY_STORAGE_KEY) ?? "[]"),
    ).toHaveLength(20);
  });
});

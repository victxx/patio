export const BROADCAST_HISTORY_STORAGE_KEY =
  "patio.direct.hoodi.broadcast-history.v1";

const MAX_HISTORY_ENTRIES = 20;

export type BroadcastMediaMode = "audio" | "video" | "video-beta";
export type BroadcastVisibility = "unlisted" | "public";

export interface BroadcastLineageSummary {
  version: 1;
  mediaCandidateCount: number;
  nonceWindowCount: number;
  sealedWindowCount: number;
  includedSealHashes: string[];
  mediaExcludedFromCanonicalHistory: boolean;
}

export interface BroadcastHistoryEntry {
  version: 1;
  id: string;
  completedAt: string;
  mediaMode: BroadcastMediaMode;
  visibility: BroadcastVisibility;
  actualSeconds: number;
  plannedSeconds: number;
  packetCount: number;
  windowCount: number;
  sessionAddress: string;
  operator: string;
  listenerUrl: string;
  chainId?: number;
  nativeCurrencySymbol?: "ETH" | "xDAI";
  registryFeeWei?: string;
  temporaryExposureWei?: string;
  returnedWei?: string;
  /** Omitted when a Wallet Call batch has a shared, non-attributable setup receipt. */
  fundingFeeWei?: string;
  cleanupFeeWei?: string;
  /** New classic results: independent of successful playback or sweep. */
  mediaIncludedHashes?: string[];
  mediaGasWei?: string;
  residualWei?: string;
  /** Omitted rather than pretending a shared Wallet Call setup fee is zero. */
  totalFeeWei?: string;
  transactionHashes: string[];
  lineageSummary?: BroadcastLineageSummary;
}

interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isLineageSummary(value: unknown): value is BroadcastLineageSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<BroadcastLineageSummary>;
  return (
    summary.version === 1 &&
    isNonNegativeInteger(summary.mediaCandidateCount) &&
    isNonNegativeInteger(summary.nonceWindowCount) &&
    isNonNegativeInteger(summary.sealedWindowCount) &&
    Array.isArray(summary.includedSealHashes) &&
    summary.includedSealHashes.every((hash) => typeof hash === "string") &&
    typeof summary.mediaExcludedFromCanonicalHistory === "boolean"
  );
}

function isHistoryEntry(value: unknown): value is BroadcastHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BroadcastHistoryEntry>;
  return (
    entry.version === 1 &&
    typeof entry.id === "string" &&
    typeof entry.completedAt === "string" &&
    (entry.mediaMode === "audio" ||
      entry.mediaMode === "video" ||
      entry.mediaMode === "video-beta") &&
    (entry.visibility === "unlisted" || entry.visibility === "public") &&
    isNonNegativeInteger(entry.actualSeconds) &&
    isNonNegativeInteger(entry.plannedSeconds) &&
    isNonNegativeInteger(entry.packetCount) &&
    isNonNegativeInteger(entry.windowCount) &&
    typeof entry.sessionAddress === "string" &&
    typeof entry.operator === "string" &&
    typeof entry.listenerUrl === "string" &&
    (entry.chainId === undefined || isNonNegativeInteger(entry.chainId)) &&
    (entry.nativeCurrencySymbol === undefined ||
      entry.nativeCurrencySymbol === "ETH" ||
      entry.nativeCurrencySymbol === "xDAI") &&
    (entry.temporaryExposureWei === undefined ||
      typeof entry.temporaryExposureWei === "string") &&
    (entry.returnedWei === undefined ||
      typeof entry.returnedWei === "string") &&
    (entry.fundingFeeWei === undefined ||
      typeof entry.fundingFeeWei === "string") &&
    (entry.cleanupFeeWei === undefined ||
      typeof entry.cleanupFeeWei === "string") &&
    (entry.residualWei === undefined || /^\d+$/.test(entry.residualWei)) &&
    (entry.mediaGasWei === undefined || /^\d+$/.test(entry.mediaGasWei)) &&
    (entry.mediaIncludedHashes === undefined ||
      (Array.isArray(entry.mediaIncludedHashes) &&
        entry.mediaIncludedHashes.length <= 160 &&
        entry.mediaIncludedHashes.every((hash) =>
          /^0x[a-fA-F0-9]{64}$/.test(hash),
        ))) &&
    (entry.totalFeeWei === undefined ||
      typeof entry.totalFeeWei === "string") &&
    Array.isArray(entry.transactionHashes) &&
    entry.transactionHashes.every((hash) => typeof hash === "string") &&
    (entry.lineageSummary === undefined ||
      isLineageSummary(entry.lineageSummary))
  );
}

export function loadBroadcastHistory(
  storage: Pick<HistoryStorage, "getItem">,
): BroadcastHistoryEntry[] {
  const stored = storage.getItem(BROADCAST_HISTORY_STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
  } catch {
    return [];
  }
}

export function appendBroadcastHistory(
  storage: HistoryStorage,
  entry: BroadcastHistoryEntry,
): BroadcastHistoryEntry[] {
  const next = [
    entry,
    ...loadBroadcastHistory(storage).filter((item) => item.id !== entry.id),
  ].slice(0, MAX_HISTORY_ENTRIES);
  storage.setItem(BROADCAST_HISTORY_STORAGE_KEY, JSON.stringify(next));
  return next;
}

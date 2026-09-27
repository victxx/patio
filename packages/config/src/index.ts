export const PATIO_DEFAULTS = {
  audioBitsPerSecond: 16_000,
  chunkDurationMs: 3_000,
  jitterBufferMs: 6_000,
  maxPacketPayloadBytes: 8 * 1024,
  maxReplacementsPerWindow: 20,
  maxSessionExposureWei: 5_000_000_000_000_000n,
  maxWindowsPerEpoch: 8,
  minSafeDurationSeconds: 60,
  minPropagationTipWei: 1_000_000_000n,
  observerPollIntervalMs: 200,
  replacementBumpBps: 1_250,
  stationFrequency: "104.2",
  stationName: "Patio",
  videoBetaAudioBitsPerSecond: 6_000,
  videoBetaHeight: 90,
  videoBetaWidth: 160,
  videoAudioBitsPerSecond: 8_000,
  videoBitsPerSecond: 12_000,
  videoFrameRate: 2,
  videoHeight: 90,
  videoTimesliceMs: 1_500,
  videoWidth: 160,
} as const;

export const PATIO_CHAIN_IDS = {
  hoodi: 560_048,
  chiado: 10_200,
  gnosis: 100,
  mainnet: 1,
} as const;

export type PatioNetworkId = "hoodi" | "chiado" | "gnosis";
export type PatioNetworkStatus = "tested" | "experimental" | "disabled";

/**
 * Evidence-aware capability states. In particular, `unverified` is not a
 * negative result: it means Patio has not run the experiment needed to decide.
 */
export type CapabilityStatus =
  "verified" | "documented" | "unverified" | "unsupported" | "unknown";

export interface CapabilityEvidence {
  status: CapabilityStatus;
  evidence: string;
}

/** How ordinary canonical transactions enter a chain. */
export type CanonicalSubmissionModel =
  | "public-mempool"
  | "private-mempool"
  | "encrypted-mempool"
  | "sequencer"
  | "unknown";

/**
 * Chain-level facts Patio needs for its future-nonce replacement transport.
 * These are deliberately distinct from the capabilities of a particular RPC.
 */
export interface PatioTransportCapabilities {
  publicMempool: CapabilityEvidence;
  futureNonceAcceptance: CapabilityEvidence;
  futureNonceGossip: CapabilityEvidence;
  sameNonceReplacement: CapabilityEvidence;
  replacementPropagation: CapabilityEvidence;
  txpoolInspection: CapabilityEvidence;
  independentObservation: CapabilityEvidence;
}

/** Descriptive account-path metadata. No alternate account path is used yet. */
export interface AccountExecutionCapabilities {
  eoa: CapabilityEvidence;
  eip7702: CapabilityEvidence;
  erc4337: CapabilityEvidence;
  paymaster: CapabilityEvidence;
  walletCallApi5792: CapabilityEvidence;
}

export interface PatioNetworkProfile {
  id: PatioNetworkId;
  chainId: number;
  name: string;
  family: "ethereum" | "gnosis";
  status: PatioNetworkStatus;
  canonicalSubmissionModel: CanonicalSubmissionModel;
  transportCapabilities: PatioTransportCapabilities;
  accountExecutionCapabilities: AccountExecutionCapabilities;
  nativeCurrency: {
    name: string;
    symbol: "ETH" | "xDAI";
    decimals: 18;
  };
  explorerBaseUrl: string;
  publicRpcUrls: readonly string[];
  faucetUrl?: string;
  transport: {
    minimumPropagationTipWei: bigint;
    replacementBumpBps: number;
    maxReplacementsPerWindow: number;
    maxWindowsPerEpoch: number;
  };
  safety: {
    defaultSessionBudgetWei: bigint;
    maximumSessionExposureWei: bigint;
    mainnet: boolean;
    enabled: boolean;
  };
}

const DEFAULT_SESSION_BUDGET_WEI = 500_000_000_000_000n;

const CONSERVATIVE_TRANSPORT_POLICY = {
  minimumPropagationTipWei: PATIO_DEFAULTS.minPropagationTipWei,
  replacementBumpBps: PATIO_DEFAULTS.replacementBumpBps,
  maxReplacementsPerWindow: PATIO_DEFAULTS.maxReplacementsPerWindow,
  maxWindowsPerEpoch: PATIO_DEFAULTS.maxWindowsPerEpoch,
} as const;

const HOODI_MANAGED_PROOF = "hoodi-managed-rpc-proof-2026-08-21";
const CHIADO_ACTIVE_PROBE_DEFERRED = "chiado-active-probe-deferred";
const GNOSIS_MAINNET_CANARY_PENDING = "gnosis-mainnet-canary-pending";
const EOA_DIRECT_FLOW = "patio-browser-local-eoa-flow";

function capability(
  status: CapabilityStatus,
  evidence: string,
): CapabilityEvidence {
  return { status, evidence };
}

const UNIMPLEMENTED_ACCOUNT_CAPABILITIES: AccountExecutionCapabilities = {
  eoa: capability("verified", EOA_DIRECT_FLOW),
  // Patio can parse this read-only, which does not verify support on any chain.
  eip7702: capability(
    "unknown",
    "read-only-parser-does-not-verify-chain-support",
  ),
  // A local client adapter does not prove chain, EntryPoint, account or
  // bundler interoperability for any configured Patio network.
  erc4337: capability(
    "unknown",
    "isolated-client-adapter-does-not-verify-network-support",
  ),
  paymaster: capability("unknown", "not-modeled-by-patio-yet"),
  walletCallApi5792: capability("unknown", "not-modeled-by-patio-yet"),
};

const HOODI_TRANSPORT_CAPABILITIES: PatioTransportCapabilities = {
  publicMempool: capability("verified", HOODI_MANAGED_PROOF),
  futureNonceAcceptance: capability("verified", HOODI_MANAGED_PROOF),
  futureNonceGossip: capability("verified", HOODI_MANAGED_PROOF),
  sameNonceReplacement: capability("verified", HOODI_MANAGED_PROOF),
  replacementPropagation: capability("verified", HOODI_MANAGED_PROOF),
  txpoolInspection: capability("verified", HOODI_MANAGED_PROOF),
  independentObservation: capability("verified", HOODI_MANAGED_PROOF),
};

function unverifiedGnosisTransport(
  evidence: string,
): PatioTransportCapabilities {
  return {
    publicMempool: capability("documented", "gnosis-network-documentation"),
    futureNonceAcceptance: capability("unverified", evidence),
    futureNonceGossip: capability("unverified", evidence),
    sameNonceReplacement: capability("unverified", evidence),
    replacementPropagation: capability("unverified", evidence),
    txpoolInspection: capability("unverified", evidence),
    independentObservation: capability("unverified", evidence),
  };
}

export const PATIO_NETWORK_PROFILES = {
  hoodi: {
    id: "hoodi",
    chainId: PATIO_CHAIN_IDS.hoodi,
    name: "Hoodi",
    family: "ethereum",
    status: "tested",
    canonicalSubmissionModel: "public-mempool",
    transportCapabilities: HOODI_TRANSPORT_CAPABILITIES,
    accountExecutionCapabilities: UNIMPLEMENTED_ACCOUNT_CAPABILITIES,
    nativeCurrency: { name: "Hoodi Ether", symbol: "ETH", decimals: 18 },
    explorerBaseUrl: "https://hoodi.etherscan.io",
    publicRpcUrls: [
      "https://ethereum-hoodi-rpc.publicnode.com",
      "https://rpc.hoodi.ethpandaops.io",
    ],
    faucetUrl: "https://faucet.chainplatform.co/faucets/ethereum-hoodi/",
    transport: CONSERVATIVE_TRANSPORT_POLICY,
    safety: {
      defaultSessionBudgetWei: DEFAULT_SESSION_BUDGET_WEI,
      // Hoodi beta ceiling explicitly raised by the operator. A quote funds
      // only its calculated plan, never this whole allowance automatically.
      maximumSessionExposureWei: 90_000_000_000_000_000n,
      mainnet: false,
      enabled: true,
    },
  },
  chiado: {
    id: "chiado",
    chainId: PATIO_CHAIN_IDS.chiado,
    name: "Chiado",
    family: "gnosis",
    status: "experimental",
    canonicalSubmissionModel: "public-mempool",
    transportCapabilities: unverifiedGnosisTransport(
      CHIADO_ACTIVE_PROBE_DEFERRED,
    ),
    accountExecutionCapabilities: UNIMPLEMENTED_ACCOUNT_CAPABILITIES,
    nativeCurrency: {
      name: "Chiado xDAI",
      symbol: "xDAI",
      decimals: 18,
    },
    explorerBaseUrl: "https://gnosis-chiado.blockscout.com",
    publicRpcUrls: [
      "https://rpc.chiadochain.net",
      "https://rpc.chiado.gnosis.gateway.fm",
    ],
    faucetUrl: "https://faucet.gnosischain.com/?chain=chiado",
    transport: CONSERVATIVE_TRANSPORT_POLICY,
    safety: {
      defaultSessionBudgetWei: DEFAULT_SESSION_BUDGET_WEI,
      maximumSessionExposureWei: PATIO_DEFAULTS.maxSessionExposureWei,
      mainnet: false,
      enabled: true,
    },
  },
  gnosis: {
    id: "gnosis",
    chainId: PATIO_CHAIN_IDS.gnosis,
    name: "Gnosis",
    family: "gnosis",
    status: "disabled",
    canonicalSubmissionModel: "public-mempool",
    transportCapabilities: unverifiedGnosisTransport(
      GNOSIS_MAINNET_CANARY_PENDING,
    ),
    accountExecutionCapabilities: UNIMPLEMENTED_ACCOUNT_CAPABILITIES,
    nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
    explorerBaseUrl: "https://gnosisscan.io",
    publicRpcUrls: [
      "https://rpc.gnosischain.com",
      "https://rpc.gnosis.gateway.fm",
    ],
    transport: CONSERVATIVE_TRANSPORT_POLICY,
    safety: {
      defaultSessionBudgetWei: DEFAULT_SESSION_BUDGET_WEI,
      maximumSessionExposureWei: PATIO_DEFAULTS.maxSessionExposureWei,
      mainnet: true,
      enabled: false,
    },
  },
} as const satisfies Record<PatioNetworkId, PatioNetworkProfile>;

export const DEFAULT_PATIO_NETWORK_ID: PatioNetworkId = "hoodi";

export function patioNetworkById(id: string): PatioNetworkProfile | undefined {
  return PATIO_NETWORK_PROFILES[id as PatioNetworkId];
}

export function patioNetworkByChainId(
  chainId: number,
): PatioNetworkProfile | undefined {
  return Object.values(PATIO_NETWORK_PROFILES).find(
    (profile) => profile.chainId === chainId,
  );
}

export function requirePatioNetworkByChainId(
  chainId: number,
): PatioNetworkProfile {
  const profile = patioNetworkByChainId(chainId);
  if (!profile) throw new Error(`Unsupported Patio chain ID: ${chainId}`);
  return profile;
}

export function isCapabilityVerified(
  capabilityValue: CapabilityEvidence | CapabilityStatus,
): boolean {
  const status =
    typeof capabilityValue === "string"
      ? capabilityValue
      : capabilityValue.status;
  return status === "verified";
}

export function isCapabilityUnsupported(
  capabilityValue: CapabilityEvidence | CapabilityStatus,
): boolean {
  const status =
    typeof capabilityValue === "string"
      ? capabilityValue
      : capabilityValue.status;
  return status === "unsupported";
}

type SubmissionModelProfile = Pick<
  PatioNetworkProfile,
  "canonicalSubmissionModel"
>;

/** True only for a chain whose ordinary transactions use a public mempool. */
export function supportsGenericPublicMempool(
  profile: SubmissionModelProfile,
): boolean {
  return profile.canonicalSubmissionModel === "public-mempool";
}

export function canonicalSubmissionModelFor(
  profile: SubmissionModelProfile,
): CanonicalSubmissionModel {
  return profile.canonicalSubmissionModel;
}

/**
 * Ready for a future caller to gate a Patio broadcast. It intentionally is not
 * wired into product availability in this metadata-only change.
 */
export function isPatioBroadcastEligible(
  profile: PatioNetworkProfile,
): boolean {
  const capabilities = profile.transportCapabilities;
  return (
    profile.safety.enabled &&
    supportsGenericPublicMempool(profile) &&
    Object.values(capabilities).every(isCapabilityVerified)
  );
}

export const PATIO_MEDIA_TYPE = "audio/webm;codecs=opus";
export const PATIO_VIDEO_MEDIA_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
] as const;

export function parseHttpOrigins(
  value: string | undefined,
  fallback = "http://localhost:3000",
): readonly string[] {
  const candidates = (value ?? fallback)
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    throw new Error("At least one web origin is required");
  }

  const origins = candidates.map((candidate) => {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error(`Invalid web origin: ${candidate}`);
    }
    return url.origin;
  });

  return [...new Set(origins)];
}

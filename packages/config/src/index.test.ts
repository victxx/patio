import { describe, expect, it } from "vitest";

import {
  PATIO_CHAIN_IDS,
  PATIO_NETWORK_PROFILES,
  canonicalSubmissionModelFor,
  isCapabilityUnsupported,
  isCapabilityVerified,
  isPatioBroadcastEligible,
  patioNetworkByChainId,
  requirePatioNetworkByChainId,
  supportsGenericPublicMempool,
} from "./index";

describe("Patio network profiles", () => {
  it("keeps Hoodi enabled with its existing limits", () => {
    const hoodi = PATIO_NETWORK_PROFILES.hoodi;
    expect(hoodi.chainId).toBe(560_048);
    expect(hoodi.nativeCurrency.symbol).toBe("ETH");
    expect(hoodi.safety.defaultSessionBudgetWei).toBe(500_000_000_000_000n);
    expect(hoodi.safety.maximumSessionExposureWei).toBe(
      90_000_000_000_000_000n,
    );
    expect(hoodi.safety.enabled).toBe(true);
    expect(hoodi.canonicalSubmissionModel).toBe("public-mempool");
    expect(hoodi.transportCapabilities.futureNonceAcceptance.status).toBe(
      "verified",
    );
    expect(isPatioBroadcastEligible(hoodi)).toBe(true);
  });

  it("resolves Chiado and Gnosis by chain ID", () => {
    expect(patioNetworkByChainId(PATIO_CHAIN_IDS.chiado)?.id).toBe("chiado");
    expect(patioNetworkByChainId(PATIO_CHAIN_IDS.gnosis)?.id).toBe("gnosis");
    expect(PATIO_NETWORK_PROFILES.chiado.nativeCurrency.symbol).toBe("xDAI");
    expect(PATIO_NETWORK_PROFILES.chiado.status).toBe("experimental");
    expect(
      PATIO_NETWORK_PROFILES.chiado.transportCapabilities.futureNonceGossip
        .status,
    ).toBe("unverified");
    expect(isPatioBroadcastEligible(PATIO_NETWORK_PROFILES.chiado)).toBe(false);
  });

  it("keeps Gnosis mainnet disabled until acceptance passes", () => {
    expect(PATIO_NETWORK_PROFILES.gnosis.status).toBe("disabled");
    expect(PATIO_NETWORK_PROFILES.gnosis.safety.enabled).toBe(false);
    expect(PATIO_NETWORK_PROFILES.gnosis.safety.mainnet).toBe(true);
  });

  it("rejects unknown chain IDs", () => {
    expect(patioNetworkByChainId(999_999)).toBeUndefined();
    expect(() => requirePatioNetworkByChainId(999_999)).toThrow(
      /Unsupported Patio chain ID/,
    );
  });

  it("keeps unverified distinct from unsupported and documented distinct from verified", () => {
    const chiado = PATIO_NETWORK_PROFILES.chiado.transportCapabilities;
    expect(isCapabilityUnsupported(chiado.futureNonceAcceptance)).toBe(false);
    expect(isCapabilityVerified(chiado.publicMempool)).toBe(false);
    expect(isCapabilityVerified(chiado.publicMempool.status)).toBe(false);
  });

  it("does not mistake every public-mempool chain for a Patio transport", () => {
    const chiado = PATIO_NETWORK_PROFILES.chiado;
    expect(supportsGenericPublicMempool(chiado)).toBe(true);
    expect(isPatioBroadcastEligible(chiado)).toBe(false);
  });

  it("does not treat a sequencer fixture as a public-mempool transport", () => {
    const sequencerFixture = { canonicalSubmissionModel: "sequencer" } as const;
    expect(canonicalSubmissionModelFor(sequencerFixture)).toBe("sequencer");
    expect(supportsGenericPublicMempool(sequencerFixture)).toBe(false);
  });

  it("keeps account execution metadata independent from canonical submission", () => {
    const hoodi = PATIO_NETWORK_PROFILES.hoodi;
    expect(hoodi.accountExecutionCapabilities.eoa.status).toBe("verified");
    expect(hoodi.accountExecutionCapabilities.erc4337.status).toBe("unknown");
    expect(hoodi.canonicalSubmissionModel).toBe("public-mempool");
  });

  it("does not let ERC-4337 metadata alter canonical transaction ingress", () => {
    const aaCapableFixture = {
      canonicalSubmissionModel: "public-mempool",
      accountExecutionCapabilities: {
        erc4337: { status: "documented", evidence: "fixture" },
      },
    } as const;
    expect(aaCapableFixture.accountExecutionCapabilities.erc4337.status).toBe(
      "documented",
    );
    expect(canonicalSubmissionModelFor(aaCapableFixture)).toBe(
      "public-mempool",
    );
  });
});

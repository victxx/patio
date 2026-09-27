import { describe, expect, it } from "vitest";

import {
  networkRuntimeByChainId,
  networkRuntimeById,
  runtimeCapabilitiesFor,
  type PatioNetworkRuntimeConfig,
} from "./network-runtime";
import { PATIO_NETWORK_PROFILES } from "@patio/config";

const configs: PatioNetworkRuntimeConfig[] = [
  {
    networkId: "hoodi",
    relayRpc: { url: "https://hoodi-sender.example" },
    observerRpc: { url: "https://hoodi-observer.example" },
    registryAddress: "0x1111111111111111111111111111111111111111",
  },
  {
    networkId: "chiado",
    relayRpc: { url: "https://chiado-sender.example" },
    observerRpc: { url: "https://chiado-observer.example" },
    registryAddress: "0x2222222222222222222222222222222222222222",
  },
];

describe("network runtime configuration", () => {
  it("never advertises the external read pool as a sender or observer", () => {
    const result = runtimeCapabilitiesFor({
      ...configs[0]!,
      relayRpc: { url: "/api/hoodi-external", providerSelection: true },
      observerRpc: { url: "" },
    });
    expect(result.sender.sendRawTransaction).toBe("unavailable");
    expect(result.sender.txpoolContentFrom).toBe("unavailable");
    expect(result.observer.basicRpc).toBe("unavailable");
  });
  it("resolves the correct observer and registry by chain ID", () => {
    expect(networkRuntimeByChainId(configs, 10_200)).toEqual(configs[1]);
    expect(networkRuntimeByChainId(configs, 560_048)).toEqual(configs[0]);
  });

  it("does not silently fall back for an unknown chain", () => {
    expect(networkRuntimeByChainId(configs, 1)).toBeUndefined();
    expect(networkRuntimeById(configs, "gnosis")).toBeUndefined();
  });

  it("keeps endpoint capability observations separate from the chain profile", () => {
    const chiadoConfig = configs[1]!;
    const configured = runtimeCapabilitiesFor(chiadoConfig);
    const unconfigured = runtimeCapabilitiesFor({
      ...chiadoConfig,
      relayRpc: { url: "" },
      observerRpc: { url: "" },
    });

    expect(configured.sender.basicRpc).toBe("unknown");
    expect(configured.observer.txpoolContentFrom).toBe("unknown");
    expect(unconfigured.sender.basicRpc).toBe("unavailable");
    expect(unconfigured.observer.nodeIdentity).toBe("unavailable");
    expect(
      PATIO_NETWORK_PROFILES.chiado.transportCapabilities.txpoolInspection
        .status,
    ).toBe("unverified");
  });
});

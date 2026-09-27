import {
  PATIO_NETWORK_PROFILES,
  type PatioNetworkId,
  type PatioNetworkProfile,
} from "@patio/config";

import type { DirectRpcConfig } from "./direct-hoodi";
import { HOODI_BETA_RPC } from "./hoodi-beta";

export interface PatioNetworkRuntimeConfig {
  networkId: PatioNetworkId;
  relayRpc: DirectRpcConfig;
  observerRpc: DirectRpcConfig;
  registryAddress: string;
  hoodiBeta?: boolean;
}

export type RuntimeRpcCapabilityStatus =
  "available" | "unavailable" | "unknown";

/**
 * Endpoint-specific observations. They never describe a chain as a whole and
 * are intentionally derived without performing RPC calls during page render.
 */
export interface RuntimeRpcCapabilities {
  basicRpc: RuntimeRpcCapabilityStatus;
  sendRawTransaction: RuntimeRpcCapabilityStatus;
  txpoolContentFrom: RuntimeRpcCapabilityStatus;
  nodeIdentity: RuntimeRpcCapabilityStatus;
}

export interface PatioNetworkRuntimeCapabilities {
  sender: RuntimeRpcCapabilities;
  observer: RuntimeRpcCapabilities;
}

function rpcConfig(
  url: string | undefined,
  authHeader?: string,
  authToken?: string,
): DirectRpcConfig {
  return {
    url: url ?? "",
    ...(authHeader ? { authHeader } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

export function patioNetworkRuntimeConfigs(): PatioNetworkRuntimeConfig[] {
  return [
    {
      networkId: "hoodi",
      hoodiBeta: process.env.PATIO_HOODI_BETA_ENABLED === "true",
      relayRpc:
        process.env.PATIO_HOODI_BETA_ENABLED === "true"
          ? { url: HOODI_BETA_RPC }
          : process.env.PATIO_HOODI_EXTERNAL_PROVIDERS_ENABLED === "true"
            ? { url: "/api/hoodi-external", providerSelection: true }
            : rpcConfig(
                process.env.NEXT_PUBLIC_HOODI_RELAY_RPC_URL,
                process.env.NEXT_PUBLIC_HOODI_RELAY_RPC_AUTH_HEADER,
                process.env.NEXT_PUBLIC_HOODI_RELAY_RPC_AUTH_TOKEN,
              ),
      observerRpc:
        process.env.PATIO_HOODI_BETA_ENABLED === "true"
          ? { url: HOODI_BETA_RPC }
          : rpcConfig(process.env.NEXT_PUBLIC_HOODI_OBSERVER_RPC_URL),
      registryAddress:
        process.env.NEXT_PUBLIC_HOODI_PATIO_REGISTRY_ADDRESS ??
        process.env.NEXT_PUBLIC_PATIO_REGISTRY_ADDRESS ??
        "",
    },
    {
      networkId: "chiado",
      relayRpc: rpcConfig(
        process.env.NEXT_PUBLIC_CHIADO_SENDER_RPC_URL,
        process.env.NEXT_PUBLIC_CHIADO_SENDER_RPC_AUTH_HEADER,
        process.env.NEXT_PUBLIC_CHIADO_SENDER_RPC_AUTH_TOKEN,
      ),
      observerRpc: rpcConfig(
        process.env.NEXT_PUBLIC_CHIADO_OBSERVER_RPC_URL,
        process.env.NEXT_PUBLIC_CHIADO_OBSERVER_RPC_AUTH_HEADER,
        process.env.NEXT_PUBLIC_CHIADO_OBSERVER_RPC_AUTH_TOKEN,
      ),
      registryAddress:
        process.env.NEXT_PUBLIC_CHIADO_PATIO_REGISTRY_ADDRESS ?? "",
    },
    {
      networkId: "gnosis",
      relayRpc: rpcConfig(
        process.env.NEXT_PUBLIC_GNOSIS_SENDER_RPC_URL,
        process.env.NEXT_PUBLIC_GNOSIS_SENDER_RPC_AUTH_HEADER,
        process.env.NEXT_PUBLIC_GNOSIS_SENDER_RPC_AUTH_TOKEN,
      ),
      observerRpc: rpcConfig(
        process.env.NEXT_PUBLIC_GNOSIS_OBSERVER_RPC_URL,
        process.env.NEXT_PUBLIC_GNOSIS_OBSERVER_RPC_AUTH_HEADER,
        process.env.NEXT_PUBLIC_GNOSIS_OBSERVER_RPC_AUTH_TOKEN,
      ),
      registryAddress:
        process.env.NEXT_PUBLIC_GNOSIS_PATIO_REGISTRY_ADDRESS ?? "",
    },
  ];
}

export function networkRuntimeById(
  configs: readonly PatioNetworkRuntimeConfig[],
  networkId: PatioNetworkId,
): PatioNetworkRuntimeConfig | undefined {
  return configs.find((config) => config.networkId === networkId);
}

export function networkRuntimeByChainId(
  configs: readonly PatioNetworkRuntimeConfig[],
  chainId: number,
): PatioNetworkRuntimeConfig | undefined {
  return configs.find(
    (config) => PATIO_NETWORK_PROFILES[config.networkId].chainId === chainId,
  );
}

export function networkProfileForRuntime(
  config: PatioNetworkRuntimeConfig,
): PatioNetworkProfile {
  return PATIO_NETWORK_PROFILES[config.networkId];
}

function endpointCapabilities(
  endpoint: DirectRpcConfig,
): RuntimeRpcCapabilities {
  const configured = endpoint.url.trim().length > 0;
  if (!configured) {
    return {
      basicRpc: "unavailable",
      sendRawTransaction: "unavailable",
      txpoolContentFrom: "unavailable",
      nodeIdentity: "unavailable",
    };
  }

  if (endpoint.providerSelection) {
    return {
      basicRpc: "unknown",
      sendRawTransaction: "unavailable",
      txpoolContentFrom: "unavailable",
      nodeIdentity: "unavailable",
    };
  }

  return {
    basicRpc: "unknown",
    // The observer must not be used to submit Patio media, but this remains an
    // endpoint fact until the preflight/probe tests it.
    sendRawTransaction: "unknown",
    txpoolContentFrom: "unknown",
    nodeIdentity: "unknown",
  };
}

export function runtimeCapabilitiesFor(
  config: PatioNetworkRuntimeConfig,
): PatioNetworkRuntimeCapabilities {
  return {
    sender: endpointCapabilities(config.relayRpc),
    observer: endpointCapabilities(config.observerRpc),
  };
}

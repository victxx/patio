import {
  PATIO_CHAIN_IDS,
  PATIO_NETWORK_PROFILES,
  type PatioNetworkProfile,
} from "@patio/config";
import {
  getAddress,
  isAddress,
  numberToHex,
  type Address,
  type Hex,
} from "viem";

export interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?(
    event: "accountsChanged" | "chainChanged" | "disconnect",
    listener: (...args: unknown[]) => void,
  ): void;
  removeListener?(
    event: "accountsChanged" | "chainChanged" | "disconnect",
    listener: (...args: unknown[]) => void,
  ): void;
}

export interface WalletHost {
  ethereum?: unknown;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
}

export function browserWalletHost(): WalletHost {
  return window;
}

export interface WalletAppearance {
  name: string;
  rdns?: string;
  icon?: string;
}

export interface InjectedWallet extends WalletAppearance {
  provider: EthereumProvider;
}

export interface ConnectedWallet extends InjectedWallet {
  address: Address;
}

interface Eip6963ProviderDetail {
  info?: { rdns?: string; name?: string; icon?: string };
  provider?: unknown;
}

export const HOODI_CHAIN_HEX = toChainIdHex(PATIO_CHAIN_IDS.hoodi);

export function toChainIdHex(chainId: number): Hex {
  const hex = numberToHex(chainId);
  return hex.length % 2 === 0 ? hex : (`0x0${hex.slice(2)}` as Hex);
}

export function readChainId(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("Wallet returned an invalid chain ID.");
}

export function providerErrorCodes(cause: unknown): number[] {
  const record = asRecord(cause);
  if (!record) return [];
  const codes: number[] = [];
  const direct = toFiniteNumber(record.code);
  if (direct !== undefined) codes.push(direct);
  const data = asRecord(record.data);
  const nested = toFiniteNumber(asRecord(data?.originalError)?.code);
  if (nested !== undefined) codes.push(nested);
  const inner = toFiniteNumber(asRecord(record.cause)?.code);
  if (inner !== undefined) codes.push(inner);
  return codes;
}

export function providerErrorMessage(cause: unknown): string {
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  const record = asRecord(cause);
  if (!record) return "";
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  const data = asRecord(record.data);
  if (typeof data?.message === "string" && data.message.trim()) {
    return data.message;
  }
  const original = asRecord(data?.originalError);
  if (typeof original?.message === "string" && original.message.trim()) {
    return original.message;
  }
  return "";
}

export function isUnrecognizedChainError(cause: unknown): boolean {
  if (providerErrorCodes(cause).includes(4902)) return true;
  const message = providerErrorMessage(cause).toLowerCase();
  return (
    message.includes("unrecognized chain") ||
    message.includes("try adding the chain") ||
    (message.includes("chain") && message.includes("not added"))
  );
}

export function isUserRejection(cause: unknown): boolean {
  if (providerErrorCodes(cause).includes(4001)) return true;
  const message = providerErrorMessage(cause).toLowerCase();
  return (
    message.includes("user rejected") ||
    message.includes("user denied") ||
    message.includes("rejected the request")
  );
}

export function formatWalletError(cause: unknown, fallback: string): string {
  if (isUserRejection(cause)) return "Wallet request was rejected.";
  if (providerErrorCodes(cause).includes(-32002)) {
    return "Open the wallet popup to continue. A request is already pending.";
  }
  return providerErrorMessage(cause) || fallback;
}

export interface WalletErrorPresentation {
  message: string;
  details: string | null;
}

export function presentWalletError(
  cause: unknown,
  fallback: string,
): WalletErrorPresentation {
  const details = providerErrorMessage(cause);
  if (isUserRejection(cause)) {
    return {
      message: "Transaction cancelled. Nothing was sent.",
      details: details || null,
    };
  }
  return {
    message: details || fallback,
    details: null,
  };
}

export function walletIconFromAnnouncement(icon: unknown): string | undefined {
  if (typeof icon !== "string" || !icon.startsWith("data:image/")) {
    return undefined;
  }
  if (icon.length > 200_000) return undefined;
  return icon;
}

export function selectInjectedWallet(
  root: unknown,
  announced: readonly Eip6963ProviderDetail[] = [],
): InjectedWallet | undefined {
  const metamask = announced.find((item) =>
    ["io.metamask", "io.metamask.flask"].includes(item.info?.rdns ?? ""),
  );
  const fromAnnouncement =
    toInjectedWallet(metamask) ??
    toInjectedWallet(announced.find((item) => isProvider(item.provider)));
  if (fromAnnouncement) return fromAnnouncement;

  const candidates = injectedCandidates(root);
  const markedMetaMask = candidates.find((provider) => {
    return Boolean((provider as { isMetaMask?: boolean }).isMetaMask);
  });
  const provider = markedMetaMask ?? candidates[0];
  if (!provider) return undefined;
  return {
    provider,
    name: markedMetaMask ? "MetaMask" : "Wallet",
  };
}

export function selectInjectedProvider(
  root: unknown,
  announced: readonly Eip6963ProviderDetail[] = [],
): EthereumProvider | undefined {
  return selectInjectedWallet(root, announced)?.provider;
}

export function discoverInjectedWallet(
  host: WalletHost,
): InjectedWallet | undefined {
  const announced: Eip6963ProviderDetail[] = [];
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (detail?.info?.rdns && isProvider(detail.provider)) {
      announced.push(detail);
    }
  };
  host.addEventListener("eip6963:announceProvider", onAnnounce);
  host.dispatchEvent(new Event("eip6963:requestProvider"));
  host.removeEventListener("eip6963:announceProvider", onAnnounce);
  return selectInjectedWallet(host.ethereum, announced);
}

export function discoverInjectedProvider(
  host: WalletHost,
): EthereumProvider | undefined {
  return discoverInjectedWallet(host)?.provider;
}

export async function ensureHoodi(provider: EthereumProvider): Promise<void> {
  return ensurePatioNetwork(provider, PATIO_NETWORK_PROFILES.hoodi);
}

export async function ensurePatioNetwork(
  provider: EthereumProvider,
  networkProfile: PatioNetworkProfile,
): Promise<void> {
  if (!networkProfile.safety.enabled) {
    throw new Error(`${networkProfile.name} is not enabled for Patio yet.`);
  }
  const currentChain = readChainId(
    await provider.request({ method: "eth_chainId" }),
  );
  if (currentChain === networkProfile.chainId) return;

  const chainHex = toChainIdHex(networkProfile.chainId);

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainHex }],
    });
  } catch (cause) {
    if (isUserRejection(cause)) {
      throw new Error("Wallet request was rejected.");
    }
    if (!isUnrecognizedChainError(cause) && !isMethodMissing(cause)) {
      throw new Error(
        formatWalletError(
          cause,
          `Could not switch the wallet to ${networkProfile.name}.`,
        ),
      );
    }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [patioChainParams(networkProfile)],
      });
    } catch (addCause) {
      if (isUserRejection(addCause)) {
        throw new Error("Wallet request was rejected.");
      }
      throw new Error(
        formatWalletError(
          addCause,
          `Could not add ${networkProfile.name} to the wallet.`,
        ),
      );
    }
    const afterAdd = readChainId(
      await provider.request({ method: "eth_chainId" }),
    );
    if (afterAdd !== networkProfile.chainId) {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
    }
  }

  const confirmed = readChainId(
    await provider.request({ method: "eth_chainId" }),
  );
  if (confirmed !== networkProfile.chainId) {
    throw new Error(
      `Switch the wallet to ${networkProfile.name} (chain ID ${networkProfile.chainId}) and try again.`,
    );
  }
}

export async function connectHoodiWallet(
  host: WalletHost,
): Promise<ConnectedWallet> {
  return connectPatioWallet(host, PATIO_NETWORK_PROFILES.hoodi);
}

export async function connectPatioWallet(
  host: WalletHost,
  networkProfile: PatioNetworkProfile,
): Promise<ConnectedWallet> {
  const injected = discoverInjectedWallet(host);
  if (!injected) {
    throw new Error(
      "Open Patio in Brave or Chrome with your wallet enabled to connect.",
    );
  }

  let accounts: unknown;
  try {
    accounts = await injected.provider.request({
      method: "eth_requestAccounts",
    });
  } catch (cause) {
    throw new Error(formatWalletError(cause, "Wallet connection failed."));
  }

  const first: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !isAddress(first)) {
    throw new Error("Wallet returned no account.");
  }

  await ensurePatioNetwork(injected.provider, networkProfile);
  return {
    ...injected,
    address: getAddress(first),
  };
}

export async function disconnectInjectedWallet(
  provider: EthereumProvider,
): Promise<void> {
  try {
    await provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    // Not every injected wallet supports permission revocation.
  }
}

function patioChainParams(
  networkProfile: PatioNetworkProfile,
): Record<string, unknown> {
  const rpcUrls = [...new Set(networkProfile.publicRpcUrls)];
  const params: Record<string, unknown> = {
    chainId: toChainIdHex(networkProfile.chainId),
    chainName: networkProfile.name,
    nativeCurrency: networkProfile.nativeCurrency,
    rpcUrls,
    blockExplorerUrls: [networkProfile.explorerBaseUrl],
  };
  return params;
}

function toInjectedWallet(
  detail: Eip6963ProviderDetail | undefined,
): InjectedWallet | undefined {
  if (!detail || !isProvider(detail.provider)) return undefined;
  const icon = walletIconFromAnnouncement(detail.info?.icon);
  const wallet: InjectedWallet = {
    provider: detail.provider,
    name: detail.info?.name?.trim() || nameFromRdns(detail.info?.rdns),
  };
  const rdns = detail.info?.rdns?.trim();
  if (rdns) wallet.rdns = rdns;
  if (icon) wallet.icon = icon;
  return wallet;
}

function nameFromRdns(rdns: string | undefined): string {
  if (rdns === "io.metamask" || rdns === "io.metamask.flask") return "MetaMask";
  return "Wallet";
}

function isMethodMissing(cause: unknown): boolean {
  const codes = providerErrorCodes(cause);
  return codes.includes(4200) || codes.includes(-32601);
}

function injectedCandidates(root: unknown): EthereumProvider[] {
  if (!root || typeof root !== "object") return [];
  const record = root as { providers?: unknown };
  if (Array.isArray(record.providers)) {
    return record.providers.filter(isProvider);
  }
  return isProvider(root) ? [root] : [];
}

function isProvider(value: unknown): value is EthereumProvider {
  return Boolean(
    value &&
    typeof value === "object" &&
    "request" in value &&
    typeof value.request === "function",
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

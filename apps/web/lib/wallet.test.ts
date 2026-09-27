import { PATIO_CHAIN_IDS, PATIO_NETWORK_PROFILES } from "@patio/config";
import { describe, expect, it } from "vitest";

import {
  connectHoodiWallet,
  disconnectInjectedWallet,
  ensurePatioNetwork,
  formatWalletError,
  HOODI_CHAIN_HEX,
  isUnrecognizedChainError,
  presentWalletError,
  selectInjectedProvider,
  toChainIdHex,
  walletIconFromAnnouncement,
  type EthereumProvider,
  type WalletHost,
} from "./wallet";

const operator = "0xe8acf143AFbF8B1371A20ea934D334180190Eac1";

class FakeHost implements WalletHost {
  ethereum?: unknown;
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly wallets: Array<{
      rdns: string;
      name?: string;
      icon?: string;
      provider: EthereumProvider;
    }> = [],
    ethereum?: unknown,
  ) {
    if (ethereum !== undefined) this.ethereum = ethereum;
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === "eip6963:announceProvider") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    if (event.type !== "eip6963:requestProvider") return false;
    for (const wallet of this.wallets) {
      const announced = new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: {
            uuid: wallet.rdns,
            name: wallet.name ?? wallet.rdns,
            icon: wallet.icon ?? "",
            rdns: wallet.rdns,
          },
          provider: wallet.provider,
        },
      });
      for (const listener of this.listeners) listener(announced);
    }
    return true;
  }
}

function wrappedUnknownChainError(): Error {
  return Object.assign(
    new Error(
      'Unrecognized chain ID "0x088bb0". Try adding the chain using wallet_addEthereumChain first.',
    ),
    {
      code: -32603,
      data: { originalError: { code: 4902 } },
    },
  );
}

function recordingProvider(options: {
  chainId?: string;
  accounts?: string[];
  switchError?: Error;
  addError?: Error;
  onAdd?: () => void;
}): EthereumProvider & { methods: string[] } {
  const methods: string[] = [];
  let chainId = options.chainId ?? "0x1";
  const provider: EthereumProvider & { methods: string[] } = {
    methods,
    request: ({ method }) => {
      methods.push(method);
      if (method === "eth_requestAccounts") {
        return Promise.resolve(options.accounts ?? [operator]);
      }
      if (method === "eth_chainId") return Promise.resolve(chainId);
      if (method === "wallet_switchEthereumChain") {
        if (options.switchError && chainId !== HOODI_CHAIN_HEX) {
          return Promise.reject(options.switchError);
        }
        chainId = HOODI_CHAIN_HEX;
        return Promise.resolve(null);
      }
      if (method === "wallet_addEthereumChain") {
        if (options.addError) return Promise.reject(options.addError);
        options.onAdd?.();
        chainId = HOODI_CHAIN_HEX;
        return Promise.resolve(null);
      }
      if (method === "wallet_revokePermissions") {
        return Promise.resolve(null);
      }
      return Promise.reject(new Error(`Unexpected wallet method: ${method}`));
    },
  };
  return provider;
}

describe("wallet connection", () => {
  it("pads Hoodi chain IDs to even-length hex", () => {
    expect(toChainIdHex(PATIO_CHAIN_IDS.hoodi)).toBe("0x088bb0");
  });

  it("adds and switches to Chiado with xDAI metadata", async () => {
    let chainId = "0x1";
    let added: Record<string, unknown> | undefined;
    const provider: EthereumProvider = {
      request: ({ method, params }) => {
        if (method === "eth_chainId") return Promise.resolve(chainId);
        if (method === "wallet_switchEthereumChain") {
          if (!added) {
            return Promise.reject(
              Object.assign(new Error("Unknown chain"), { code: 4902 }),
            );
          }
          chainId = String((params?.[0] as { chainId?: string }).chainId);
          return Promise.resolve(null);
        }
        if (method === "wallet_addEthereumChain") {
          added = params?.[0] as Record<string, unknown>;
          chainId = String(added.chainId);
          return Promise.resolve(null);
        }
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
    };

    await ensurePatioNetwork(provider, PATIO_NETWORK_PROFILES.chiado);
    expect(chainId).toBe("0x27d8");
    expect(added?.nativeCurrency).toEqual({
      name: "Chiado xDAI",
      symbol: "xDAI",
      decimals: 18,
    });
  });

  it("treats wrapped MetaMask 4902 errors as an unknown chain", () => {
    expect(isUnrecognizedChainError(wrappedUnknownChainError())).toBe(true);
    expect(isUnrecognizedChainError({ code: 4902 })).toBe(true);
  });

  it("prefers an announced MetaMask provider over window.ethereum", () => {
    const metamask = recordingProvider({ chainId: HOODI_CHAIN_HEX });
    const hijacked = recordingProvider({ chainId: "0x1" });
    const selected = selectInjectedProvider(hijacked, [
      { info: { rdns: "app.phantom" }, provider: hijacked },
      { info: { rdns: "io.metamask" }, provider: metamask },
    ]);
    expect(selected).toBe(metamask);
  });

  it("asks for accounts before switching to Hoodi", async () => {
    const provider = recordingProvider({
      chainId: "0x1",
      switchError: wrappedUnknownChainError(),
    });
    const connected = await connectHoodiWallet(new FakeHost([], provider));
    expect(connected.address).toBe(operator);
    expect(provider.methods[0]).toBe("eth_requestAccounts");
    expect(provider.methods).toContain("wallet_addEthereumChain");
    expect(provider.methods.indexOf("eth_requestAccounts")).toBeLessThan(
      provider.methods.indexOf("wallet_switchEthereumChain"),
    );
  });

  it("adds Hoodi when switch fails with a wrapped 4902", async () => {
    const added: string[] = [];
    const provider = recordingProvider({
      chainId: "0x1",
      switchError: wrappedUnknownChainError(),
      onAdd: () => added.push("hoodi"),
    });
    await connectHoodiWallet(new FakeHost([], provider));
    expect(added).toEqual(["hoodi"]);
  });

  it("switches after adding Hoodi if the wallet stays on the previous chain", async () => {
    const methods: string[] = [];
    let added = false;
    let chainId = "0x1";
    const provider: EthereumProvider = {
      request: ({ method }) => {
        methods.push(method);
        if (method === "eth_requestAccounts") {
          return Promise.resolve([operator]);
        }
        if (method === "eth_chainId") return Promise.resolve(chainId);
        if (method === "wallet_switchEthereumChain") {
          if (!added) return Promise.reject(wrappedUnknownChainError());
          chainId = HOODI_CHAIN_HEX;
          return Promise.resolve(null);
        }
        if (method === "wallet_addEthereumChain") {
          added = true;
          return Promise.resolve(null);
        }
        return Promise.reject(new Error(`Unexpected wallet method: ${method}`));
      },
    };
    await connectHoodiWallet(new FakeHost([], provider));
    expect(
      methods.filter((method) => method === "wallet_switchEthereumChain"),
    ).toHaveLength(2);
  });

  it("explains a rejected wallet request", () => {
    expect(formatWalletError({ code: 4001 }, "Wallet connection failed.")).toBe(
      "Wallet request was rejected.",
    );
  });

  it("keeps verbose wallet rejection data behind a concise presentation", () => {
    const technicalMessage =
      "User rejected the request. Request Arguments: chain: Hoodi data: 0xa4d3";
    expect(
      presentWalletError(
        Object.assign(new Error(technicalMessage), { code: 4001 }),
        "Transaction failed.",
      ),
    ).toEqual({
      message: "Transaction cancelled. Nothing was sent.",
      details: technicalMessage,
    });
  });

  it("keeps only data-URI wallet icons from EIP-6963 announcements", () => {
    expect(
      walletIconFromAnnouncement("https://example/fox.png"),
    ).toBeUndefined();
    expect(walletIconFromAnnouncement("data:image/svg+xml,<svg></svg>")).toBe(
      "data:image/svg+xml,<svg></svg>",
    );
  });

  it("returns the announced MetaMask name and icon", async () => {
    const icon = "data:image/svg+xml,<svg></svg>";
    const metamask = recordingProvider({ chainId: HOODI_CHAIN_HEX });
    const connected = await connectHoodiWallet(
      new FakeHost(
        [
          {
            rdns: "io.metamask",
            name: "MetaMask",
            icon,
            provider: metamask,
          },
        ],
        recordingProvider({ chainId: "0x1" }),
      ),
    );
    expect(connected.name).toBe("MetaMask");
    expect(connected.icon).toBe(icon);
    expect(connected.provider).toBe(metamask);
  });

  it("revokes wallet permissions when disconnecting", async () => {
    const provider = recordingProvider({ chainId: HOODI_CHAIN_HEX });
    await disconnectInjectedWallet(provider);
    expect(provider.methods).toContain("wallet_revokePermissions");
  });
});

"use client";

import {
  PATIO_NETWORK_PROFILES,
  type PatioNetworkId,
  type PatioNetworkProfile,
} from "@patio/config";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  browserWalletHost,
  connectPatioWallet,
  disconnectInjectedWallet,
  ensurePatioNetwork,
  type ConnectedWallet,
} from "../lib/wallet";

interface WalletSessionValue {
  wallet: ConnectedWallet | null;
  balanceWei: bigint | null;
  connecting: boolean;
  sessionLocked: boolean;
  networkId: PatioNetworkId;
  connect: (networkProfile?: PatioNetworkProfile) => Promise<void>;
  selectNetwork: (networkProfile: PatioNetworkProfile) => void;
  switchNetwork: (networkProfile: PatioNetworkProfile) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  setSessionLocked: (locked: boolean) => void;
}

const WalletSessionContext = createContext<WalletSessionValue | null>(null);

export function WalletSessionProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [sessionLocked, updateSessionLocked] = useState(false);
  const sessionLockedRef = useRef(false);
  const connectionRef = useRef<Promise<void> | null>(null);
  const setSessionLocked = useCallback((locked: boolean) => {
    sessionLockedRef.current = locked;
    updateSessionLocked(locked);
  }, []);
  const [networkId, setNetworkId] = useState<PatioNetworkId>("hoodi");

  const connect = useCallback(
    (
      networkProfile: PatioNetworkProfile = PATIO_NETWORK_PROFILES.hoodi,
    ): Promise<void> => {
      if (sessionLockedRef.current)
        return Promise.reject(
          new Error(
            "Keep the current session wallet connected until it is resolved.",
          ),
        );
      if (connectionRef.current) return connectionRef.current;
      setConnecting(true);
      const request = connectPatioWallet(browserWalletHost(), networkProfile)
        .then((connected) => {
          setWallet(connected);
          setNetworkId(networkProfile.id);
        })
        .finally(() => {
          connectionRef.current = null;
          setConnecting(false);
        });
      connectionRef.current = request;
      return request;
    },
    [],
  );

  const switchNetwork = useCallback(
    async (networkProfile: PatioNetworkProfile): Promise<void> => {
      if (!wallet) throw new Error("Connect a wallet first.");
      await ensurePatioNetwork(wallet.provider, networkProfile);
      setNetworkId(networkProfile.id);
      const balance = await wallet.provider.request({
        method: "eth_getBalance",
        params: [wallet.address, "latest"],
      });
      setBalanceWei(
        typeof balance === "string" && /^0x[0-9a-f]+$/i.test(balance)
          ? BigInt(balance)
          : null,
      );
    },
    [wallet],
  );
  const selectNetwork = useCallback((networkProfile: PatioNetworkProfile) => {
    if (networkProfile.safety.enabled) {
      setNetworkId(networkProfile.id);
      setBalanceWei(null);
    }
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    if (sessionLocked) return;
    const provider = wallet?.provider;
    setWallet(null);
    setBalanceWei(null);
    if (provider) await disconnectInjectedWallet(provider);
  }, [sessionLocked, wallet]);

  const refreshBalance = useCallback(async (): Promise<void> => {
    if (!wallet) {
      setBalanceWei(null);
      return;
    }
    try {
      const balance = await wallet.provider.request({
        method: "eth_getBalance",
        params: [wallet.address, "latest"],
      });
      if (typeof balance !== "string" || !/^0x[0-9a-f]+$/i.test(balance)) {
        throw new Error("Wallet returned an invalid network balance.");
      }
      setBalanceWei(BigInt(balance));
    } catch {
      setBalanceWei(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    void refreshBalance();
    const interval = window.setInterval(() => void refreshBalance(), 30_000);
    return () => window.clearInterval(interval);
  }, [refreshBalance, wallet]);

  const value = useMemo(
    () => ({
      wallet,
      balanceWei,
      connecting,
      sessionLocked,
      networkId,
      connect,
      selectNetwork,
      switchNetwork,
      disconnect,
      refreshBalance,
      setSessionLocked,
    }),
    [
      wallet,
      balanceWei,
      connecting,
      sessionLocked,
      networkId,
      connect,
      selectNetwork,
      switchNetwork,
      disconnect,
      refreshBalance,
      setSessionLocked,
    ],
  );

  return (
    <WalletSessionContext.Provider value={value}>
      {children}
    </WalletSessionContext.Provider>
  );
}

export function useWalletSession(): WalletSessionValue {
  const value = useContext(WalletSessionContext);
  if (!value) {
    throw new Error(
      "useWalletSession must be used within WalletSessionProvider",
    );
  }
  return value;
}

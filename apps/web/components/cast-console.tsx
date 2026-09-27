"use client";

import {
  PATIO_CHAIN_IDS,
  PATIO_DEFAULTS,
  PATIO_MEDIA_TYPE,
} from "@patio/config";
import {
  broadcastAuthorizationTypedData,
  MEDIA_TRANSACTION_GAS,
  serializeBroadcastAuthorization,
  type BroadcastAuthorizationV1,
} from "@patio/ethereum";
import {
  createStreamId,
  encodePatioPacket,
  PatioCodec,
  PatioPacketType,
} from "@patio/protocol";
import {
  bytesToHex,
  createWalletClient,
  custom,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { hoodi } from "viem/chains";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  patioFetch,
  shortAddress,
  type FeePlanResponse,
} from "../lib/patio-api";
import {
  browserWalletHost,
  discoverInjectedProvider,
  ensureHoodi,
} from "../lib/wallet";
import { useWalletSession } from "./wallet-session";

interface WalletStateResponse {
  address: Address;
  chainId: number;
  nonce: string;
  balanceWei: string;
}

interface SessionResponse {
  id: Hex;
  status: string;
}

interface StopResponse {
  status: string;
  releaseBroadcast: boolean;
  message?: string;
}

interface PreparedSession {
  id: Hex;
  account: PrivateKeyAccount;
  authorization: BroadcastAuthorizationV1;
  feePlan: FeePlanResponse;
  seals: Map<bigint, Hex>;
}

type CastPhase =
  | "disconnected"
  | "connected"
  | "preparing"
  | "funding"
  | "ready"
  | "live"
  | "cleaning"
  | "ended"
  | "held";

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function CastConsole({ relayUrl }: { relayUrl: string }) {
  const { wallet, connecting, connect, setSessionLocked } = useWalletSession();
  const operator = wallet?.address ?? null;
  const [phase, setPhase] = useState<CastPhase>("disconnected");
  const [seconds, setSeconds] = useState(0);
  const [packetCount, setPacketCount] = useState(0);
  const [safeDuration, setSafeDuration] = useState<number | null>(null);
  const [exposureWei, setExposureWei] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<PreparedSession | null>(null);
  const sequenceRef = useRef(0);
  const processingRef = useRef(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupStartedRef = useRef(false);

  const submitTransaction = useCallback(
    async (sessionId: Hex, rawTransaction: Hex): Promise<void> => {
      await patioFetch(
        new URL(`/v1/sessions/${sessionId}/transactions`, relayUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rawTransaction }),
        },
      );
    },
    [relayUrl],
  );

  const submitSeal = useCallback(
    async (session: PreparedSession, nonce: bigint): Promise<void> => {
      const rawTransaction = session.seals.get(nonce);
      if (!rawTransaction)
        throw new Error("Pre-signed window seal is missing.");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await submitTransaction(session.id, rawTransaction);
          return;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "";
          if (!message.includes("observer has not confirmed")) throw cause;
          await wait(500);
        }
      }
      throw new Error("Observer node B did not confirm the last media packet.");
    },
    [submitTransaction],
  );

  const finishSession = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || cleanupStartedRef.current) return;
    cleanupStartedRef.current = true;
    setPhase("cleaning");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await patioFetch<StopResponse>(
          new URL(`/v1/sessions/${session.id}/stop`, relayUrl),
          { method: "POST" },
        );
        if (response.releaseBroadcast) {
          setPhase("ended");
          return;
        }
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Cleanup failed.";
        if (!message.includes("observer has not confirmed")) {
          setError(message);
          setPhase("held");
          return;
        }
      }
      await wait(1_000);
    }
    setError(
      "Cleanup is waiting for observer node B. The nonce gap remains held.",
    );
    setPhase("held");
  }, [relayUrl]);

  const stopRecorder = useCallback((): void => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      stopRecorder();
    },
    [stopRecorder],
  );

  useEffect(() => {
    setSessionLocked(
      ["preparing", "funding", "ready", "live", "cleaning", "held"].includes(
        phase,
      ),
    );
  }, [phase, setSessionLocked]);

  useEffect(() => () => setSessionLocked(false), [setSessionLocked]);

  useEffect(() => {
    if (wallet) {
      setPhase((current) =>
        current === "disconnected" ? "connected" : current,
      );
      return;
    }
    stopRecorder();
    sessionRef.current = null;
    cleanupStartedRef.current = false;
    setSafeDuration(null);
    setExposureWei(null);
    setPacketCount(0);
    setSeconds(0);
    setPhase("disconnected");
  }, [wallet, stopRecorder]);

  const connectWallet = async (): Promise<void> => {
    setError(null);
    try {
      await connect();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Wallet connection failed.",
      );
    }
  };

  const prepareSession = async (): Promise<void> => {
    const provider =
      wallet?.provider ?? discoverInjectedProvider(browserWalletHost());
    if (!provider || !operator || !relayUrl) {
      setError("Connect a wallet and configure the Ethereum relay first.");
      return;
    }
    setError(null);
    setPhase("preparing");
    cleanupStartedRef.current = false;
    try {
      await ensureHoodi(provider);
      const feePlan = await patioFetch<FeePlanResponse>(
        new URL("/v1/fees", relayUrl),
      );
      if (!feePlan.canStart || feePlan.windows < 1) {
        throw new Error("Current Hoodi fees cannot safely support 60 seconds.");
      }

      const account = privateKeyToAccount(generatePrivateKey());
      const walletState = await patioFetch<WalletStateResponse>(
        new URL(`/v1/wallets/${account.address}`, relayUrl),
      );
      if (walletState.chainId !== PATIO_CHAIN_IDS.hoodi) {
        throw new Error("Relay is not connected to Hoodi.");
      }
      const nonceStart = BigInt(walletState.nonce);
      const nonceEnd = nonceStart + BigInt(feePlan.windows);
      const authorization: BroadcastAuthorizationV1 = {
        version: 1,
        operator,
        sessionAddress: account.address,
        streamId: createStreamId(),
        chainId: PATIO_CHAIN_IDS.hoodi,
        expiresAt: BigInt(Math.floor(Date.now() / 1_000) + 30 * 60),
        nonceStart,
        nonceEnd,
        maxPayloadBytes: PATIO_DEFAULTS.maxPacketPayloadBytes,
        maxReplacementsPerWindow: PATIO_DEFAULTS.maxReplacementsPerWindow,
        maxFeePerGasWei: BigInt(feePlan.sealMaxFeePerGasWei),
        maxTotalExposureWei: PATIO_DEFAULTS.maxSessionExposureWei,
        relayOrigin: new URL(relayUrl).origin,
      };
      const commonCleanup = {
        chainId: authorization.chainId,
        type: "eip1559" as const,
        to: account.address,
        value: 0n,
        data: "0x" as const,
        gas: 21_000n,
        maxFeePerGas: BigInt(feePlan.sealMaxFeePerGasWei),
        maxPriorityFeePerGas: BigInt(feePlan.sealPriorityFeePerGasWei),
      };
      const seals = new Map<bigint, Hex>();
      const emergencyTransactions: Array<{
        kind: "seal" | "release" | "sweep";
        nonce: string;
        rawTransaction: Hex;
      }> = [];
      for (let nonce = nonceStart + 1n; nonce <= nonceEnd; nonce += 1n) {
        const rawTransaction = await account.signTransaction({
          ...commonCleanup,
          nonce: Number(nonce),
        });
        seals.set(nonce, rawTransaction);
        emergencyTransactions.push({
          kind: "seal",
          nonce: nonce.toString(),
          rawTransaction,
        });
      }
      const release = await account.signTransaction({
        ...commonCleanup,
        nonce: Number(nonceStart),
      });
      emergencyTransactions.push({
        kind: "release",
        nonce: nonceStart.toString(),
        rawTransaction: release,
      });
      const sweepValue =
        PATIO_DEFAULTS.maxSessionExposureWei - BigInt(feePlan.cleanupCostWei);
      if (sweepValue < 0n) {
        throw new Error("Fee plan exceeds the session-wallet exposure cap.");
      }
      const sweep = await account.signTransaction({
        ...commonCleanup,
        to: operator,
        value: sweepValue,
        nonce: Number(nonceEnd + 1n),
      });
      emergencyTransactions.push({
        kind: "sweep",
        nonce: (nonceEnd + 1n).toString(),
        rawTransaction: sweep,
      });

      const walletClient = createWalletClient({
        account: operator,
        chain: hoodi,
        transport: custom(provider),
      });
      const signature = await walletClient.signTypedData({
        account: operator,
        ...broadcastAuthorizationTypedData(authorization),
      });
      const registered = await patioFetch<SessionResponse>(
        new URL("/v1/sessions", relayUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            authorization: serializeBroadcastAuthorization(authorization),
            signature,
            emergencyTransactions,
          }),
        },
      );

      setSafeDuration(feePlan.affordableDurationSeconds);
      setExposureWei(PATIO_DEFAULTS.maxSessionExposureWei);
      setPhase("funding");
      await walletClient.sendTransaction({
        account: operator,
        chain: hoodi,
        to: account.address,
        value: PATIO_DEFAULTS.maxSessionExposureWei,
      });
      for (let attempt = 0; attempt < 36; attempt += 1) {
        const funded = await patioFetch<WalletStateResponse>(
          new URL(`/v1/wallets/${account.address}`, relayUrl),
        );
        if (BigInt(funded.balanceWei) >= PATIO_DEFAULTS.maxSessionExposureWei) {
          sessionRef.current = {
            id: registered.id,
            account,
            authorization,
            feePlan,
            seals,
          };
          sequenceRef.current = 0;
          setPacketCount(0);
          setSeconds(0);
          setPhase("ready");
          return;
        }
        await wait(5_000);
      }
      throw new Error(
        "Funding was submitted but not confirmed by relay node A.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Session setup failed.",
      );
      setPhase("connected");
    }
  };

  const processAudioChunk = useCallback(
    async (blob: Blob): Promise<void> => {
      const session = sessionRef.current;
      if (!session) throw new Error("No prepared Ethereum session.");
      const sequence = sequenceRef.current;
      const windowIndex = Math.floor(
        sequence / PATIO_DEFAULTS.maxReplacementsPerWindow,
      );
      if (windowIndex >= session.feePlan.windows) {
        stopRecorder();
        return;
      }
      const replacementIndex =
        sequence % PATIO_DEFAULTS.maxReplacementsPerWindow;
      const envelope = encodePatioPacket({
        version: 1,
        type: sequence === 0 ? PatioPacketType.START : PatioPacketType.AUDIO,
        codec: PatioCodec.OPUS_WEBM,
        flags: 0,
        streamId: session.authorization.streamId,
        windowIndex,
        sequence,
        capturedAtMs: BigInt(Date.now()),
        payload: new Uint8Array(await blob.arrayBuffer()),
      });
      const nonce = session.authorization.nonceStart + 1n + BigInt(windowIndex);
      const rawTransaction = await session.account.signTransaction({
        chainId: session.authorization.chainId,
        type: "eip1559",
        to: session.account.address,
        value: 0n,
        data: bytesToHex(envelope),
        gas: MEDIA_TRANSACTION_GAS,
        nonce: Number(nonce),
        maxFeePerGas: BigInt(
          session.feePlan.mediaFeeLadderWei[replacementIndex] ?? "0",
        ),
        maxPriorityFeePerGas: BigInt(
          session.feePlan.mediaPriorityFeeLadderWei[replacementIndex] ?? "0",
        ),
      });
      await submitTransaction(session.id, rawTransaction);
      sequenceRef.current += 1;
      setPacketCount(sequenceRef.current);
      if (replacementIndex === PATIO_DEFAULTS.maxReplacementsPerWindow - 1) {
        await submitSeal(session, nonce);
        if (windowIndex === session.feePlan.windows - 1) stopRecorder();
      }
    },
    [stopRecorder, submitSeal, submitTransaction],
  );

  const startBroadcast = async (): Promise<void> => {
    if (!sessionRef.current) {
      setError("Prepare and fund an Ethereum session first.");
      return;
    }
    setError(null);
    if (
      typeof MediaRecorder === "undefined" ||
      !MediaRecorder.isTypeSupported(PATIO_MEDIA_TYPE)
    ) {
      setError("Use desktop Chrome to broadcast Opus audio.");
      return;
    }
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      });
      const recorder = new MediaRecorder(mediaStream, {
        mimeType: PATIO_MEDIA_TYPE,
        audioBitsPerSecond: PATIO_DEFAULTS.audioBitsPerSecond,
      });
      processingRef.current = Promise.resolve();
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) return;
        processingRef.current = processingRef.current
          .then(() => processAudioChunk(event.data))
          .catch((cause: unknown) => {
            setError(
              cause instanceof Error
                ? cause.message
                : "Ethereum packet failed.",
            );
            stopRecorder();
          });
      });
      recorder.addEventListener("stop", () => {
        mediaStream.getTracks().forEach((track) => track.stop());
        void processingRef.current.finally(() => void finishSession());
      });
      recorderRef.current = recorder;
      streamRef.current = mediaStream;
      recorder.start(PATIO_DEFAULTS.chunkDurationMs);
      setPhase("live");
      timerRef.current = setInterval(() => {
        setSeconds((current) => current + 1);
      }, 1_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone failed.");
    }
  };

  const resetSession = (): void => {
    sessionRef.current = null;
    cleanupStartedRef.current = false;
    setSafeDuration(null);
    setExposureWei(null);
    setPacketCount(0);
    setSeconds(0);
    setError(null);
    setPhase(operator ? "connected" : "disconnected");
  };

  const isBusy = ["preparing", "funding", "cleaning"].includes(phase);
  const status =
    phase === "live"
      ? "Live on Hoodi"
      : phase === "held"
        ? "Gap held safely"
        : phase === "ended"
          ? "Ended"
          : phase === "ready"
            ? "Ready"
            : operator
              ? "Wallet connected"
              : "Connect wallet";

  return (
    <section
      className="simple-card cast-card"
      aria-labelledby="broadcast-title"
    >
      <span className={`simple-status${phase === "live" ? " is-live" : ""}`}>
        {status}
      </span>
      <h1 id="broadcast-title">Broadcast</h1>
      <p className="simple-copy">
        Wallet identity, ephemeral session key, and audio through Hoodi
        mempools.
      </p>

      <div className={`simple-signal${phase === "live" ? " is-live" : ""}`}>
        {Array.from({ length: 12 }, (_, index) => (
          <span key={index} />
        ))}
      </div>

      {phase === "disconnected" ? (
        <button
          className="primary-action"
          type="button"
          disabled={connecting}
          onClick={connectWallet}
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      ) : phase === "connected" ? (
        <button
          className="primary-action"
          type="button"
          onClick={prepareSession}
        >
          Prepare & fund broadcast
        </button>
      ) : phase === "ready" ? (
        <button
          className="primary-action"
          type="button"
          onClick={startBroadcast}
        >
          Start broadcast
        </button>
      ) : phase === "live" ? (
        <button
          className="primary-action danger"
          type="button"
          onClick={stopRecorder}
        >
          Stop safely
        </button>
      ) : phase === "ended" ? (
        <button className="primary-action" type="button" onClick={resetSession}>
          New broadcast
        </button>
      ) : (
        <button className="primary-action" type="button" disabled>
          {isBusy ? "Working…" : "Session held"}
        </button>
      )}

      <p className="simple-meta">
        {phase === "live"
          ? `${formatTime(seconds)} · ${packetCount} Ethereum packets`
          : operator
            ? `${shortAddress(operator)} · Hoodi`
            : "Maintainer wallet required"}
      </p>
      {safeDuration !== null && exposureWei !== null ? (
        <p className="session-budget">
          Up to {formatTime(safeDuration)} · {formatEther(exposureWei)} ETH
          session cap
        </p>
      ) : null}
      {!relayUrl ? (
        <p className="simple-error">Ethereum relay not configured.</p>
      ) : null}
      {error ? <p className="simple-error">{error}</p> : null}
    </section>
  );
}

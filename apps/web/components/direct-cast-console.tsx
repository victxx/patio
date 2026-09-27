"use client";

import { useNetworkFees } from "../lib/use-network-fees";
import type { SingleNonceTransport } from "../lib/single-nonce-transport";
import { retirementPresentation } from "../lib/retirement-presentation";
import { ClassicSession, classicReceiptFee } from "../lib/classic-session";
import { observeClassicMedia } from "../lib/classic-media-observation";
import {
  readClassicSealEvidence,
  type ExpectedClassicSeal,
} from "../lib/classic-seal-evidence";
import type { CancellationReview } from "../lib/classic-session";
import type { ControlledClassicTest } from "../lib/controlled-classic-test";
import {
  AudioPreflight,
  initialMicrophoneState,
  PATIO_AUDIO_CONSTRAINTS,
  hasLiveAudio,
  microphoneError,
  patioAudioOptions,
  stopOnAudioEnded,
} from "../lib/audio-preflight";

import {
  PATIO_DEFAULTS,
  PATIO_MEDIA_TYPE,
  PATIO_NETWORK_PROFILES,
  PATIO_VIDEO_MEDIA_TYPES,
  type PatioNetworkId,
  type PatioNetworkProfile,
} from "@patio/config";
import {
  MEDIA_TRANSACTION_GAS,
  PATIO_REGISTRY_ABI,
  type FeePlan,
} from "@patio/ethereum";
import {
  createStreamId,
  encodePatioPacket,
  fragmentVideoSegment,
  PatioCodec,
  PatioPacketType,
} from "@patio/protocol";
import {
  bytesToHex,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatGwei,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  networkRuntimeById,
  type PatioNetworkRuntimeConfig,
} from "../lib/network-runtime";
import {
  BrowserEthereumRpc,
  DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS,
  DIRECT_VIDEO_PACKET_DWELL_MS,
  DIRECT_SESSION_STORAGE_KEY,
  directSessionUrl,
  flattenTxpoolTransactions,
  type DirectSessionDescriptor,
  type DirectRpcConfig,
} from "../lib/direct-hoodi";
import {
  appendBroadcastHistory,
  type BroadcastMediaMode,
  type BroadcastVisibility,
} from "../lib/broadcast-history";
import {
  addMediaReplacementCandidate,
  addPatioEmptySealCandidate,
  createPatioReplacementLineage,
  markPatioReplacementObserved,
  type PatioReplacementLineage,
} from "../lib/patio-replacement-lineage";
import {
  createAffordableDirectPlan,
  createRequiredDirectPlan,
  directPlanRequiresReprepare,
  estimateDirectNetworkCost,
  type DirectFeePlan,
  type DirectNetworkCostEstimate,
} from "../lib/direct-plan";
import { shortAddress } from "../lib/patio-api";
import {
  browserWalletHost,
  discoverInjectedProvider,
  presentWalletError,
} from "../lib/wallet";
import {
  fetchPublicBroadcasts,
  parseRegistryAddress,
} from "../lib/patio-registry";
import {
  assertReturnPlanFitsNetwork,
  assessAtomicSetupReadiness,
  atomicPublicSetupFeatureEnabled,
  createAtomicPublicSetupPlan,
  createPatioReturnPlan,
  decodeRegistryOperatorApproval,
  decodeRegistryStreamOperator,
  mayUseExistingStreamOperator,
  reserveAtomicSetupAttempt,
  snapshotReturnRecipient,
  updateAtomicSetupAttempt,
  type AtomicPublicSetupPlan,
  type PatioSetupMode,
} from "../lib/atomic-public-setup";
import {
  discoverWalletCallCapabilities,
  dispatchReviewedWalletCallBatch,
  readWalletCallBatchStatus,
  walletProviderSessionId,
} from "../lib/wallet-call-api";
import type { WalletCallBatchRecord } from "@patio/wallet-core";
import {
  frameWebmAudioPayload,
  frameWebmTransportPayload,
  makeWebmChunkSeekable,
  makeWebmVideoChunkBootstrapped,
} from "../lib/webm";
import { MediaDiagnosticsSession } from "../lib/media-diagnostics";
import { mediaCapacityDecision } from "../lib/media-capacity";
import { assertNewDirectBroadcastAllowed } from "../lib/direct-transport-safety";
import {
  EthereumExecutionPanel,
  type EthereumExecutionProof,
  type EthereumTraceAction,
  type EthereumTracePhase,
} from "./ethereum-execution-panel";
import { MediaDiagnosticsPanel } from "./media-diagnostics-panel";

import { useWalletSession } from "./wallet-session";
import { AnimatedCounter } from "./ui/animated-counter";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const CAST_GLASS_STYLE = {
  backdropFilter: "blur(5px) saturate(108%)",
  WebkitBackdropFilter: "blur(5px) saturate(108%)",
} satisfies CSSProperties;

const CAST_BACKDROP_STYLE = {
  backdropFilter: "blur(1px) saturate(104%)",
  WebkitBackdropFilter: "blur(1px) saturate(104%)",
} satisfies CSSProperties;

const PREPARATION_GLASS_STYLE = {
  backdropFilter: "blur(11px) saturate(108%)",
  WebkitBackdropFilter: "blur(11px) saturate(108%)",
} satisfies CSSProperties;
const EMPTY_RPC_CONFIG: DirectRpcConfig = { url: "" };

function ShareIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="5" cy="10" r="2" />
      <circle cx="14.5" cy="5" r="2" />
      <circle cx="14.5" cy="15" r="2" />
      <path d="m6.8 9 5.9-3M6.8 11l5.9 3" />
    </svg>
  );
}

function LiveAudioMeter({ stream }: { stream: MediaStream | null }) {
  const meterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!stream) return;
    const context = new AudioContext({ latencyHint: "interactive" });
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(stream);
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.76;
    source.connect(analyser);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;

    const paint = () => {
      analyser.getByteFrequencyData(frequencies);
      const bars = meterRef.current?.children;
      if (bars) {
        for (let index = 0; index < bars.length; index += 1) {
          const level = Math.max(
            0.12,
            Math.min(1, (frequencies[index + 1] ?? 0) / 185),
          );
          (bars[index] as HTMLElement).style.transform = `scaleY(${level})`;
        }
      }
      frame = requestAnimationFrame(paint);
    };

    void context.resume().catch(() => undefined);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
  }, [stream]);

  return (
    <div
      ref={meterRef}
      className="simple-signal is-live is-metered"
      aria-label="Live microphone level"
    >
      {Array.from({ length: 16 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

interface PreparedDirectSession {
  transportMode?: "legacy" | "classic-v2";
  classic?: ClassicSession;
  networkId: PatioNetworkId;
  account: PrivateKeyAccount;
  descriptor: DirectSessionDescriptor;
  feePlan: FeePlan;
  replacementsPerWindow: number;
  totalPackets: number;
  seals: Hex[];
  release: Hex;
  sweep: Hex | null;
  cleanupReserveWei: bigint;
  sweepGasLimit: bigint;
  setupMode: PatioSetupMode;
  listenerUrl: string;
  fundingHash: Hex | null;
  registryHash: Hex | null;
  /** Atomic wallet batches do not attribute a shared outer receipt per call. */
  registryFeeWei: bigint | null;
  setupReceiptHashes: readonly Hex[];
  fundingAmountWei: bigint;
  safetyMarginWei: bigint;
  mediaMode: BroadcastMediaMode;
  packetDurationMs: number;
  videoCodec: PatioCodec.WEBM_VP8_OPUS | PatioCodec.WEBM_VP9_OPUS | null;
  videoMimeType: string | null;
  visibility: BroadcastVisibility;
  startedAtMs: number | null;
  recordingEndedAtMs: number | null;
}

interface PreparedRetirementSession {
  transportMode: "single-nonce-retirement-v1";
  transport: SingleNonceTransport;
  descriptor: DirectSessionDescriptor;
  totalPackets: number;
  mediaMode: BroadcastMediaMode;
  packetDurationMs: number;
  videoCodec: PatioCodec.WEBM_VP8_OPUS | PatioCodec.WEBM_VP9_OPUS | null;
  videoMimeType: string | null;
  fundingAmountWei: bigint;
  safetyMarginWei: bigint;
  startedAtMs: number | null;
  recordingEndedAtMs: number | null;
}

interface PendingAtomicPreparedSession {
  session: Omit<
    PreparedDirectSession,
    "fundingHash" | "registryHash" | "registryFeeWei" | "setupReceiptHashes"
  >;
  plan: AtomicPublicSetupPlan;
}

function saveClassicHistory(session: PreparedDirectSession): void {
  const classic = session.classic;
  if (!classic) return;
  const feeSum = (media: boolean) => {
    const fees = classic.signatures
      .filter(
        (s) => classic.receipts.has(s.hash) && (s.role === "media") === media,
      )
      .map((s) => classicReceiptFee(classic.receipts.get(s.hash)!));
    return fees.some((fee) => fee === null)
      ? undefined
      : fees.reduce<bigint>((sum, fee) => sum + fee!, 0n).toString();
  };
  const cleanupFeeWei = feeSum(false),
    mediaGasWei = feeSum(true);
  const fundingFee = classic.financialFees.get("funding");
  appendBroadcastHistory(localStorage, {
    version: 1,
    id: session.descriptor.streamId,
    completedAt: new Date().toISOString(),
    mediaMode: session.mediaMode,
    visibility: session.visibility,
    actualSeconds:
      session.startedAtMs && session.recordingEndedAtMs
        ? Math.max(
            0,
            Math.round(
              (session.recordingEndedAtMs - session.startedAtMs) / 1_000,
            ),
          )
        : 0,
    plannedSeconds: Math.floor(
      (session.totalPackets * session.packetDurationMs) / 1_000,
    ),
    packetCount: classic.signatures.filter((s) => s.role === "media").length,
    windowCount: session.feePlan.windows,
    sessionAddress: session.account.address,
    operator: session.descriptor.operator,
    listenerUrl: session.listenerUrl,
    chainId: session.descriptor.chainId,
    temporaryExposureWei: session.fundingAmountWei.toString(),
    ...(cleanupFeeWei === undefined ? {} : { cleanupFeeWei }),
    ...(mediaGasWei === undefined ? {} : { mediaGasWei }),
    ...(fundingFee === undefined || fundingFee === null
      ? {}
      : { fundingFeeWei: fundingFee.toString() }),
    ...(session.registryFeeWei === null
      ? {}
      : { registryFeeWei: session.registryFeeWei.toString() }),
    ...(classic.returned === null
      ? {}
      : { returnedWei: classic.returned.toString() }),
    ...(classic.residual === null
      ? {}
      : { residualWei: classic.residual.toString() }),
    mediaIncludedHashes: [...classic.mediaIncluded],
    transactionHashes: [
      ...new Set([
        ...classic.financial
          .filter((f) => f.state === "confirmed" && f.hash)
          .map((f) => f.hash!),
        ...classic.receipts.keys(),
      ]),
    ],
  });
}

const DEFAULT_DURATION_SECONDS = 90;
const MIN_DURATION_SECONDS = 15;
const VIDEO_QUEUE_PAUSE_DEPTH = 4;
const VIDEO_QUEUE_ABORT_DEPTH = 8;
const RADIO_TICK_COUNT = 31;
const LiveReactions = dynamic(
  () => import("./live-reactions").then((module) => module.LiveReactions),
  { ssr: false },
);

type PreparationStage =
  "device" | "network" | "session" | "safety" | "registry" | "funding";

interface PreparationStep {
  id: PreparationStage;
  label: string;
  description: string;
}

interface LiveFees {
  baseFeePerGasWei: bigint;
  priorityFeePerGasWei: bigint;
  updatedAtMs: number;
}

interface VideoProfile {
  mimeType: (typeof PATIO_VIDEO_MEDIA_TYPES)[number];
  codec: PatioCodec.WEBM_VP8_OPUS | PatioCodec.WEBM_VP9_OPUS;
}

const VIDEO_PROFILES: readonly VideoProfile[] = [
  {
    mimeType: PATIO_VIDEO_MEDIA_TYPES[0],
    codec: PatioCodec.WEBM_VP8_OPUS,
  },
  {
    mimeType: PATIO_VIDEO_MEDIA_TYPES[1],
    codec: PatioCodec.WEBM_VP9_OPUS,
  },
];

type CastPhase = EthereumTracePhase;

const EMPTY_EXECUTION_PROOF: EthereumExecutionProof = {
  fundingHash: null,
  registryHash: null,
  lastMediaHash: null,
  sealHash: null,
  releaseHash: null,
  sweepHash: null,
};

function preparationSteps(
  visibility: BroadcastVisibility,
  networkProfile: PatioNetworkProfile,
): PreparationStep[] {
  return [
    {
      id: "device",
      label: "Testing your device",
      description:
        "Audio uses the checked live microphone stream. Nothing is transmitted before Start.",
    },
    {
      id: "network",
      label: `Checking ${networkProfile.name}`,
      description: "Checking the connection and current network fees.",
    },
    {
      id: "session",
      label: "Creating the session",
      description:
        "A temporary broadcast wallet is generated only in this browser tab.",
    },
    {
      id: "safety",
      label: "Preparing the broadcast",
      description: "Preparing the transactions needed to end your broadcast.",
    },
    ...(visibility === "public"
      ? [
          {
            id: "registry" as const,
            label: "Approve public listing",
            description:
              "Your connected wallet announces this live in Patio's public registry.",
          },
        ]
      : []),
    {
      id: "funding",
      label: "Approve temporary funding",
      description: `Your wallet sends only the required ${networkProfile.nativeCurrency.symbol}. Unused funds are swept back after cleanup.`,
    },
  ];
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function AnimatedTime({ seconds }: { seconds: number }) {
  const minutes = Math.floor(seconds / 60);
  return (
    <span className="animated-time" aria-label={formatTime(seconds)}>
      <AnimatedCounter value={minutes} duration={0.42} />
      <span aria-hidden="true">:</span>
      <AnimatedCounter value={seconds % 60} padStart={2} duration={0.42} />
    </span>
  );
}

interface RadioTickStyle extends CSSProperties {
  "--radio-tick-height": string;
  "--radio-tick-opacity": string;
}

function RadioDurationSlider({
  minimum,
  maximum,
  value,
  onChange,
}: {
  minimum: number;
  maximum: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const progress =
    maximum === minimum ? 0 : (value - minimum) / (maximum - minimum);
  const selectedTick = Math.round(progress * (RADIO_TICK_COUNT - 1));

  return (
    <div className="radio-duration-slider">
      <div className="radio-duration-slider__ticks" aria-hidden="true">
        {Array.from({ length: RADIO_TICK_COUNT }, (_, index) => {
          const distance = Math.abs(index - selectedTick);
          const emphasis = Math.max(0, 6 - distance);
          const style: RadioTickStyle = {
            "--radio-tick-height": `${7 + emphasis * 3}px`,
            "--radio-tick-opacity": `${Math.max(0.22, 0.92 - distance * 0.08)}`,
          };
          return (
            <span
              key={index}
              className={`${index <= selectedTick ? "is-active" : ""}${index === selectedTick ? " is-current" : ""}`}
              style={style}
            />
          );
        })}
      </div>
      <input
        aria-label="Requested broadcast duration"
        type="range"
        min={minimum}
        max={maximum}
        step={5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function mediaProfileLabel(mediaMode: BroadcastMediaMode): string {
  if (mediaMode === "video") {
    return `${PATIO_DEFAULTS.videoWidth}×${PATIO_DEFAULTS.videoHeight} · ${PATIO_DEFAULTS.videoFrameRate} fps · ~${(PATIO_DEFAULTS.videoBitsPerSecond + PATIO_DEFAULTS.videoAudioBitsPerSecond) / 1_000} kbps`;
  }
  return `${PATIO_DEFAULTS.audioBitsPerSecond / 1_000} kbps`;
}

function FeePlanPanel({
  open,
  onClose,
  liveFees,
  quotedPlan,
  networkCostEstimate,
  loading,
  unavailableMessage,
  networkProfile,
}: {
  open: boolean;
  onClose: () => void;
  liveFees: LiveFees | null;
  quotedPlan: DirectFeePlan | null;
  networkCostEstimate: DirectNetworkCostEstimate | null;
  loading: boolean;
  unavailableMessage: string | null;
  networkProfile: PatioNetworkProfile;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          id="fee-plan-panel"
          className="fee-plan-panel"
          aria-label="Fee plan"
          initial={
            reduceMotion
              ? false
              : {
                  opacity: 0,
                  scale: 0.92,
                }
          }
          animate={{
            opacity: 1,
            scale: 1,
          }}
          exit={{
            opacity: 0,
            scale: 0.92,
          }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.4, ease: [0.22, 1, 0.36, 1] }
          }
          style={{ ...CAST_GLASS_STYLE, transformOrigin: "center" }}
        >
          <header className="fee-plan-panel__header">
            <div>
              <span>Current transaction limits</span>
              <h2>Fee plan</h2>
            </div>
            <button type="button" aria-label="Close fee plan" onClick={onClose}>
              ×
            </button>
          </header>
          {liveFees && quotedPlan ? (
            <div className="fee-plan-panel__content">
              <section className="fee-plan-group">
                <h3>At a glance</h3>
                <dl className="broadcast-budget__summary">
                  <div>
                    <dt>Current gas</dt>
                    <dd>
                      {Number(
                        formatGwei(
                          liveFees.baseFeePerGasWei +
                            liveFees.priorityFeePerGasWei,
                        ),
                      ).toFixed(2)}{" "}
                      gwei
                    </dd>
                  </div>
                  <div>
                    <dt>
                      Temporary {networkProfile.nativeCurrency.symbol} required
                    </dt>
                    <dd className="fee-plan-value--key">
                      {formatEth(quotedPlan.requiredFundingWei)}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Estimated empty-cleanup scenario</dt>
                    <dd className="fee-plan-value--key">
                      ~{formatEth(networkCostEstimate?.totalWei ?? 0n)}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Illustrative return if no media is included</dt>
                    <dd>
                      ~
                      {formatEth(
                        quotedPlan.requiredFundingWei -
                          (networkCostEstimate?.cleanupWei ?? 0n) >
                          0n
                          ? quotedPlan.requiredFundingWei -
                              (networkCostEstimate?.cleanupWei ?? 0n)
                          : 0n,
                      )}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="fee-plan-group">
                <h3>Transaction plan</h3>
                <dl className="broadcast-budget__technical">
                  <div>
                    <dt>Base + priority</dt>
                    <dd>
                      {formatGwei(liveFees.baseFeePerGasWei)} +{" "}
                      {formatGwei(liveFees.priorityFeePerGasWei)} gwei
                    </dd>
                  </div>
                  <div>
                    <dt>Replacement bump</dt>
                    <dd>
                      {networkProfile.transport.replacementBumpBps / 100}%
                    </dd>
                  </div>
                  <div>
                    <dt>Windows × replacements</dt>
                    <dd>
                      {quotedPlan.feePlan.windows} ×{" "}
                      {quotedPlan.replacementsPerWindow}
                    </dd>
                  </div>
                  <div>
                    <dt>Cleanup transactions</dt>
                    <dd>{quotedPlan.feePlan.windows + 2}</dd>
                  </div>
                  <div>
                    <dt>Peak pending media</dt>
                    <dd>
                      {formatEth(quotedPlan.feePlan.mediaPeakCostWei)}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Safety margin</dt>
                    <dd>
                      {formatEth(quotedPlan.safetyMarginWei)}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Maximum authorized gas exposure across nonces</dt>
                    <dd>
                      {formatEther(quotedPlan.feePlan.maximumExposureWei)}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>Empty-cleanup reserve (alternative scenario)</dt>
                    <dd>
                      {formatEther(quotedPlan.feePlan.cleanupCostWei)}{" "}
                      {networkProfile.nativeCurrency.symbol}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          ) : (
            <p className="broadcast-budget__notice is-warning">
              {loading
                ? `Reading live ${networkProfile.name} gas…`
                : (unavailableMessage ?? "Fee plan unavailable.")}
            </p>
          )}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

function formatEth(wei: bigint, maximumDecimals = 7): string {
  const [whole, fraction = ""] = formatEther(wei).split(".");
  const trimmed = fraction.slice(0, maximumDecimals).replace(/0+$/, "");
  return trimmed ? `${whole ?? "0"}.${trimmed}` : (whole ?? "0");
}

function maximumDurationSeconds(
  mediaMode: BroadcastMediaMode,
  networkProfile: PatioNetworkProfile,
): number {
  if (mediaMode === "video") {
    return Math.floor(
      (networkProfile.transport.maxWindowsPerEpoch *
        networkProfile.transport.maxReplacementsPerWindow *
        PATIO_DEFAULTS.videoTimesliceMs) /
        1_000,
    );
  }
  return 180;
}

function packetDurationMs(mediaMode: BroadcastMediaMode): number {
  return mediaMode === "video"
    ? PATIO_DEFAULTS.videoTimesliceMs
    : PATIO_DEFAULTS.chunkDurationMs;
}

function mediaConstraints(wantsVideo: boolean): MediaStreamConstraints {
  return {
    audio: { ...PATIO_AUDIO_CONSTRAINTS },
    video: wantsVideo
      ? {
          width: { ideal: PATIO_DEFAULTS.videoWidth },
          height: { ideal: PATIO_DEFAULTS.videoHeight },
          frameRate: {
            ideal: PATIO_DEFAULTS.videoFrameRate,
            max: PATIO_DEFAULTS.videoFrameRate,
          },
        }
      : false,
  };
}

function mediaRecorderOptions(
  wantsVideo: boolean,
  mimeType: string,
): MediaRecorderOptions & { videoKeyFrameIntervalCount?: number } {
  return {
    mimeType,
    audioBitsPerSecond: wantsVideo
      ? PATIO_DEFAULTS.videoAudioBitsPerSecond
      : PATIO_DEFAULTS.audioBitsPerSecond,
    ...(wantsVideo
      ? {
          videoBitsPerSecond: PATIO_DEFAULTS.videoBitsPerSecond,
          // Frequent keyframes shorten recovery after a listener joins.
          // Chromium ignores unknown dictionary members, so older builds
          // safely fall back to their native keyframe policy.
          videoKeyFrameIntervalCount: 1,
        }
      : {}),
  };
}

async function verifyMediaCapture(
  wantsVideo: boolean,
  mimeType: string,
): Promise<void> {
  const mediaStream = await navigator.mediaDevices.getUserMedia(
    mediaConstraints(wantsVideo),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let bytes = 0;
      let settled = false;
      let stopTimer = 0;
      let timeoutTimer = 0;
      const recorder = new MediaRecorder(
        mediaStream,
        mediaRecorderOptions(wantsVideo, mimeType),
      );
      const settle = (cause?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(stopTimer);
        window.clearTimeout(timeoutTimer);
        if (cause) reject(cause);
        else resolve();
      };
      recorder.addEventListener("dataavailable", (event) => {
        bytes += event.data.size;
      });
      recorder.addEventListener("error", () => {
        settle(new Error("The browser media encoder failed its test."));
      });
      recorder.addEventListener("stop", () => {
        settle(
          bytes > 0
            ? undefined
            : new Error("The browser media test produced no encoded data."),
        );
      });
      recorder.start(250);
      stopTimer = window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 850);
      timeoutTimer = window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
        settle(new Error("The browser media test timed out."));
      }, 5_000);
    });
  } finally {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function transactionHash(rawTransaction: Hex): Hex {
  return keccak256(rawTransaction);
}

function viemChainForProfile(networkProfile: PatioNetworkProfile) {
  return defineChain({
    id: networkProfile.chainId,
    name: networkProfile.name,
    nativeCurrency: networkProfile.nativeCurrency,
    rpcUrls: {
      default: { http: [...networkProfile.publicRpcUrls] },
    },
    blockExplorers: {
      default: {
        name: `${networkProfile.name} explorer`,
        url: networkProfile.explorerBaseUrl,
      },
    },
  });
}

function selectVideoProfile(): VideoProfile | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaSource === "undefined"
  ) {
    return null;
  }
  return (
    VIDEO_PROFILES.find(
      ({ mimeType }) =>
        MediaRecorder.isTypeSupported(mimeType) &&
        MediaSource.isTypeSupported(mimeType),
    ) ?? null
  );
}

async function waitForObserver(
  rpc: BrowserEthereumRpc,
  sessionAddress: Address,
  expectedHash: Hex,
  hooks?: {
    onPoll?: (durationMs: number, attempt: number) => void;
    onObserved?: (durationMs: number) => void;
    onError?: (durationMs: number, attempt: number) => void;
  },
  seal?: ExpectedClassicSeal,
): Promise<void> {
  const startedAt = performance.now();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pollStartedAt = performance.now();
    if (seal) {
      if (await readClassicSealEvidence(rpc, { ...seal, hash: expectedHash }))
        return;
      await wait(DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS);
      continue;
    }
    let content: unknown;
    try {
      content = await rpc.txpoolContentFrom(sessionAddress);
      hooks?.onPoll?.(performance.now() - pollStartedAt, attempt + 1);
    } catch (cause) {
      hooks?.onError?.(performance.now() - pollStartedAt, attempt + 1);
      throw cause;
    }
    if (
      flattenTxpoolTransactions(content).some(
        (transaction) =>
          transaction.hash.toLowerCase() === expectedHash.toLowerCase(),
      )
    ) {
      hooks?.onObserved?.(performance.now() - startedAt);
      return;
    }
    await wait(DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS);
  }
  throw new Error("The configured observer did not see the transaction.");
}

export function DirectCastConsole({
  networkConfigs,
  privatePrepared,
  privateAudioReady,
  controlledTest,
  reviewPanel,
  reviewDetails,
}: {
  networkConfigs: readonly PatioNetworkRuntimeConfig[];
  /** Trusted private-fixture host only; never supplied by a public page or URL. */
  privatePrepared?: {
    transport: SingleNonceTransport;
    mediaMode: BroadcastMediaMode;
    audioInput?: AudioPreflight;
    listenerUrl?: string;
  };
  privateAudioReady?: boolean;
  controlledTest?: ControlledClassicTest;
  reviewPanel?: ReactNode;
  reviewDetails?: ReactNode;
}) {
  const {
    wallet,
    balanceWei,
    connecting,
    sessionLocked,
    connect,
    switchNetwork,
    refreshBalance,
    setSessionLocked,
  } = useWalletSession();
  const operator = wallet?.address ?? null;
  const networkId: PatioNetworkId = "hoodi";
  const networkProfile: PatioNetworkProfile = PATIO_NETWORK_PROFILES[networkId];
  const networkRuntime = networkRuntimeById(networkConfigs, networkId);
  const relayRpc: DirectRpcConfig =
    networkRuntime?.relayRpc ?? EMPTY_RPC_CONFIG;
  const observerRpc = networkRuntime?.observerRpc ?? EMPTY_RPC_CONFIG;
  const registryAddress = parseRegistryAddress(
    networkRuntime?.registryAddress ?? "",
  );
  const [phase, setPhase] = useState<CastPhase>("disconnected");
  const prepareBusyRef = useRef(false);
  const classicAudioRef = useRef<AudioPreflight | null>(null);
  const microphoneButtonRef = useRef<HTMLButtonElement>(null);
  const cameraButtonRef = useRef<HTMLButtonElement>(null);
  const [microphoneAttention, setMicrophoneAttention] = useState(false);
  const [classicMicrophone, setClassicMicrophone] = useState(
    initialMicrophoneState,
  );
  const [classicResult, setClassicResult] = useState<string | null>(null);
  const [cameraCheck, setCameraCheck] = useState<
    "unchecked" | "checking" | "ready"
  >("unchecked");
  const cameraCheckBusy = useRef(false);
  const [cancelReview, setCancelReview] = useState<CancellationReview | null>(
    null,
  );
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancelBusyRef = useRef(false);
  const [extraFundingHashes, setExtraFundingHashes] = useState("");
  useEffect(() => {
    if (privatePrepared) return;
    const input = new AudioPreflight(setClassicMicrophone);
    classicAudioRef.current = input;
    return () => {
      input.dispose();
      classicAudioRef.current = null;
    };
  }, [privatePrepared]);
  const [mediaMode, setMediaMode] = useState<BroadcastMediaMode>("audio");
  const [visibility, setVisibility] = useState<BroadcastVisibility>("unlisted");
  const [setupMode, setSetupMode] = useState<PatioSetupMode>("classic");
  const [atomicSetupReview, setAtomicSetupReview] =
    useState<AtomicPublicSetupPlan | null>(null);
  const [atomicSetupState, setAtomicSetupState] = useState<
    "review" | "awaiting-verification" | "held" | null
  >(null);
  const [durationTargetSeconds, setDurationTargetSeconds] = useState(
    controlledTest ? 15 : DEFAULT_DURATION_SECONDS,
  );
  const feeRead = useNetworkFees(relayRpc, networkProfile.chainId);
  const liveFees = feeRead.fees;
  const feeQuoteError = feeRead.error;
  const feeQuoteLoading = feeRead.loading;
  const [preparationStage, setPreparationStage] =
    useState<PreparationStage | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<"fee" | "proof" | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [packetCount, setPacketCount] = useState(0);
  const [segmentCount, setSegmentCount] = useState(0);
  const [mediaBytes, setMediaBytes] = useState(0);
  const [plannedDurationSeconds, setPlannedDurationSeconds] = useState<
    number | null
  >(null);
  const [listenerUrl, setListenerUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [traceSession, setTraceSession] = useState<
    | (DirectSessionDescriptor & {
        maxPackets: number;
        windows: number;
        replacementsPerWindow: number;
        requiredFundingWei: string;
        mediaMode: BroadcastMediaMode;
        videoCodec: string | null;
      })
    | null
  >(null);
  const [traceAction, setTraceAction] = useState<EthereumTraceAction>("verify");
  const [executionProof, setExecutionProof] = useState<EthereumExecutionProof>(
    EMPTY_EXECUTION_PROOF,
  );
  const lineageRef = useRef<PatioReplacementLineage>(
    createPatioReplacementLineage(),
  );
  const [replacementLineage, setReplacementLineage] =
    useState<PatioReplacementLineage>(lineageRef.current);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const privateStartBusyRef = useRef(false);
  const diagnosticsRef = useRef<MediaDiagnosticsSession | null>(null);
  diagnosticsRef.current ??= new MediaDiagnosticsSession(
    "broadcaster",
    networkProfile.chainId,
  );
  const diagnostics = diagnosticsRef.current;
  const diagnosticsTokenRef = useRef(0);
  const mediaObservationRef = useRef<Promise<void> | null>(null);
  const mediaChunkIdRef = useRef(0);
  const previousRecorderTimecodeRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<
    PreparedDirectSession | PreparedRetirementSession | null
  >(null);
  const pendingAtomicSessionRef = useRef<PendingAtomicPreparedSession | null>(
    null,
  );
  const atomicBatchRecordRef = useRef<WalletCallBatchRecord | null>(null);
  const atomicDispatchingRef = useRef(false);
  const sequenceRef = useRef(0);
  const videoSegmentIndexRef = useRef(0);
  const webmInitializationRef = useRef<Uint8Array | null>(null);
  const videoBootstrapRef = useRef<Uint8Array | null>(null);
  const processingRef = useRef(Promise.resolve());
  const queuedMediaChunksRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupStartedRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const directConfigured = Boolean(relayRpc.url && observerRpc.url);
  const atomicSetupEnabled = atomicPublicSetupFeatureEnabled();

  const updateReplacementLineage = useCallback(
    (
      update: (current: PatioReplacementLineage) => PatioReplacementLineage,
    ): PatioReplacementLineage => {
      const next = update(lineageRef.current);
      if (next !== lineageRef.current) {
        lineageRef.current = next;
        setReplacementLineage(next);
      }
      return next;
    },
    [],
  );

  const architectureMaximumDuration = maximumDurationSeconds(
    mediaMode,
    networkProfile,
  );
  const mediaPacketDurationMs = packetDurationMs(mediaMode);
  const maximumAffordablePlan = useMemo(() => {
    if (!liveFees) return null;
    return createAffordableDirectPlan(
      liveFees.baseFeePerGasWei,
      liveFees.priorityFeePerGasWei,
      architectureMaximumDuration,
      networkProfile.safety.maximumSessionExposureWei,
      mediaPacketDurationMs,
      networkProfile,
      setupMode === "classic" ? "classic-per-nonce-v2" : "historical",
    );
  }, [
    architectureMaximumDuration,
    liveFees,
    mediaPacketDurationMs,
    networkProfile,
    setupMode,
  ]);
  const maximumSelectableDuration = liveFees
    ? Math.max(
        MIN_DURATION_SECONDS,
        Math.min(
          architectureMaximumDuration,
          maximumAffordablePlan?.feePlan.affordableDurationSeconds ??
            MIN_DURATION_SECONDS,
        ),
      )
    : architectureMaximumDuration;
  // Never silently accept a shorter duration after corrected exposure/fee changes.
  const selectedDurationSeconds = durationTargetSeconds;
  const quotedPlan = useMemo(() => {
    if (!liveFees) return null;
    return createRequiredDirectPlan(
      liveFees.baseFeePerGasWei,
      liveFees.priorityFeePerGasWei,
      selectedDurationSeconds,
      networkProfile.safety.maximumSessionExposureWei,
      mediaPacketDurationMs,
      networkProfile,
      setupMode === "classic" ? "classic-per-nonce-v2" : "historical",
    );
  }, [
    liveFees,
    mediaPacketDurationMs,
    networkProfile,
    selectedDurationSeconds,
    setupMode,
  ]);
  const networkCostEstimate = useMemo(
    () =>
      quotedPlan && liveFees
        ? estimateDirectNetworkCost(
            quotedPlan,
            liveFees.priorityFeePerGasWei,
            visibility === "public",
          )
        : null,
    [liveFees, quotedPlan, visibility],
  );
  const activePreparationSteps = preparationSteps(visibility, networkProfile);
  const preparationStepIndex = preparationStage
    ? activePreparationSteps.findIndex(({ id }) => id === preparationStage)
    : -1;
  const activePreparationStep =
    preparationStepIndex >= 0
      ? activePreparationSteps[preparationStepIndex]
      : null;

  const selectMediaMode = (nextMode: BroadcastMediaMode): void => {
    if (sessionRef.current || prepareBusyRef.current) return;
    classicAudioRef.current?.turnOff();
    const nextArchitectureMaximum = maximumDurationSeconds(
      nextMode,
      networkProfile,
    );
    const nextPacketDuration = packetDurationMs(nextMode);
    const nextMaximum = liveFees
      ? (createAffordableDirectPlan(
          liveFees.baseFeePerGasWei,
          liveFees.priorityFeePerGasWei,
          nextArchitectureMaximum,
          networkProfile.safety.maximumSessionExposureWei,
          nextPacketDuration,
          networkProfile,
          setupMode === "classic" ? "classic-per-nonce-v2" : "historical",
        )?.feePlan.affordableDurationSeconds ?? MIN_DURATION_SECONDS)
      : nextArchitectureMaximum;
    setMediaMode(nextMode);
    setDurationTargetSeconds((current) => Math.min(current, nextMaximum));
  };

  const shareListenerLink = async (): Promise<void> => {
    if (!listenerUrl) return;
    try {
      await navigator.clipboard.writeText(listenerUrl);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1_800);
    } catch {
      setError("The listener link could not be copied.");
    }
  };

  const stopRecorder = useCallback((): void => {
    stopRequestedRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
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
    if (privatePrepared) {
      const { transport, mediaMode: mode } = privatePrepared;
      if (
        sessionRef.current?.descriptor.sessionAddress ===
        transport.descriptor.sessionAddress
      )
        return;
      if (sessionRef.current) {
        setError(
          "An existing session still owns this controller. Do not replace its memory-only custody.",
        );
        return;
      }
      if (
        !transport.snapshot().funded ||
        transport.snapshot().state !== "prepared"
      ) {
        setError(
          "Private fixture session must be canonically funded and prepared.",
        );
        return;
      }
      sessionRef.current = {
        transportMode: "single-nonce-retirement-v1",
        transport,
        descriptor: transport.descriptor,
        totalPackets: transport.plan.candidates,
        mediaMode: mode,
        packetDurationMs: mode === "audio" ? 3000 : 1500,
        videoCodec: mode === "video" ? PatioCodec.WEBM_VP8_OPUS : null,
        videoMimeType: mode === "video" ? PATIO_VIDEO_MEDIA_TYPES[0] : null,
        fundingAmountWei: transport.plan.requiredExposure,
        safetyMarginWei: transport.plan.safetyMargin,
        startedAtMs: null,
        recordingEndedAtMs: null,
      };
      setMediaMode(mode);
      if (privatePrepared.listenerUrl)
        setListenerUrl(privatePrepared.listenerUrl);
      setPlannedDurationSeconds(transport.plan.estimatedDurationSeconds);
      setPhase("ready");
      return;
    }
    if (wallet) {
      setPhase((current) =>
        current === "disconnected" ? "connected" : current,
      );
      return;
    }
    if (sessionRef.current || pendingAtomicSessionRef.current) {
      // Losing the wallet connection says nothing about a financial request
      // already dispatched. Never release the session's memory-only custody.
      setError(
        "Wallet disconnected; session retained. Keep this tab open and reconcile known transactions. Do not prepare or fund again.",
      );
      return;
    }
    stopRecorder();
    sessionRef.current = null;
    pendingAtomicSessionRef.current = null;
    atomicBatchRecordRef.current = null;
    atomicDispatchingRef.current = false;
    setAtomicSetupReview(null);
    setAtomicSetupState(null);
    cleanupStartedRef.current = false;
    setPacketCount(0);
    setSegmentCount(0);
    setMediaBytes(0);
    setSeconds(0);
    setPlannedDurationSeconds(null);
    setListenerUrl(null);
    setTraceSession(null);
    setExecutionProof(EMPTY_EXECUTION_PROOF);
    const emptyLineage = createPatioReplacementLineage();
    lineageRef.current = emptyLineage;
    setReplacementLineage(emptyLineage);
    setTraceAction("verify");
    setPreparationStage(null);
    setSidePanel(null);
    setPhase("disconnected");
  }, [wallet, stopRecorder, privatePrepared]);

  const connectWallet = async (): Promise<void> => {
    setError(null);
    setErrorDetails(null);
    try {
      await connect(networkProfile);
    } catch (cause) {
      const presented = presentWalletError(cause, "Wallet connection failed.");
      setError(presented.message);
      setErrorDetails(presented.details);
    }
  };

  const prepareSession = async (): Promise<void> => {
    if (cameraCheckBusy.current) return;
    if (!privatePrepared && mediaMode === "video" && cameraCheck !== "ready") {
      setMicrophoneAttention(true);
      cameraButtonRef.current?.focus();
      return;
    }
    if (
      !privatePrepared &&
      mediaMode === "audio" &&
      classicAudioRef.current?.state.status !== "ready"
    ) {
      setMicrophoneAttention(true);
      microphoneButtonRef.current?.focus();
      return;
    }
    if (
      prepareBusyRef.current ||
      sessionRef.current ||
      pendingAtomicSessionRef.current
    ) {
      setError(
        "A session or preparation is already retained. Reconcile it; do not fund again.",
      );
      return;
    }
    if (privatePrepared) {
      setError(
        "Private fixture preparation/funding belongs to its explicit host; no public fallback.",
      );
      return;
    }
    const provider =
      wallet?.provider ?? discoverInjectedProvider(browserWalletHost());
    if (!provider || !operator) {
      setError(`Connect the ${networkProfile.name} wallet first.`);
      return;
    }
    if (setupMode === "wallet-atomic") {
      if (!atomicSetupEnabled) {
        setError(
          "Atomic wallet setup is disabled by Patio's experimental feature flag.",
        );
        return;
      }
      if (
        visibility !== "public" ||
        networkId !== "hoodi" ||
        !registryAddress
      ) {
        setError(
          "Atomic wallet setup is currently limited to public Hoodi broadcasts with a configured PatioRegistry.",
        );
        return;
      }
    }
    prepareBusyRef.current = true;
    setError(null);
    setErrorDetails(null);
    setPhase("preparing");
    setPlannedDurationSeconds(null);
    setTraceSession(null);
    setExecutionProof(EMPTY_EXECUTION_PROOF);
    const emptyLineage = createPatioReplacementLineage();
    lineageRef.current = emptyLineage;
    setReplacementLineage(emptyLineage);
    setTraceAction("verify");
    setPreparationStage("device");
    cleanupStartedRef.current = false;
    try {
      if (controlledTest) {
        if (controlledTest.mode === "hoodi-beta")
          assertNewDirectBroadcastAllowed({
            senderRpcUrl: relayRpc.url,
            observerRpcUrl: observerRpc.url,
            chainId: networkProfile.chainId,
            hoodiBeta: networkRuntime?.hoodiBeta === true,
          });
        if (
          setupMode !== "classic" ||
          (controlledTest.mode !== "hoodi-beta" &&
            (mediaMode !== "audio" ||
              visibility !== "unlisted" ||
              selectedDurationSeconds > 15))
        )
          throw new Error(
            "Controlled test is one short unlisted classic audio session only",
          );
        await controlledTest.assertReady();
      } else
        assertNewDirectBroadcastAllowed({
          senderRpcUrl: relayRpc.url,
          observerRpcUrl: observerRpc.url,
        });
      if (relayRpc.providerSelection)
        throw new Error(
          "Configured Hoodi provider pool is read-only, not a media sender. Public preparation remains blocked.",
        );
      const videoProfile = mediaMode === "video" ? selectVideoProfile() : null;
      if (mediaMode === "video" && !videoProfile) {
        throw new Error(
          "This browser cannot record and play Patio WebM video. Use desktop Chrome.",
        );
      }
      const selectedMediaType = videoProfile?.mimeType ?? PATIO_MEDIA_TYPE;
      if (
        typeof MediaRecorder === "undefined" ||
        !MediaRecorder.isTypeSupported(selectedMediaType)
      ) {
        throw new Error(
          "This browser cannot encode the selected Patio media format.",
        );
      }
      try {
        if (mediaMode === "audio") {
          if (!classicAudioRef.current)
            throw new Error("Microphone preflight missing");
          classicAudioRef.current.assertReady();
        } else await verifyMediaCapture(true, selectedMediaType);
      } catch (cause) {
        const reason = cause instanceof Error ? ` ${cause.message}` : "";
        throw new Error(
          `${mediaMode === "video" ? "Camera and microphone" : "Microphone"} test failed before any wallet transaction was requested.${reason}`,
        );
      }

      setPreparationStage("network");
      const selectedPacketDurationMs = packetDurationMs(mediaMode);
      await switchNetwork(networkProfile);
      const sender = new BrowserEthereumRpc(
        controlledTest?.rpcConfig ?? relayRpc,
      );
      const observer = new BrowserEthereumRpc(
        controlledTest?.rpcConfig ?? observerRpc,
      );
      const [
        senderChainId,
        observerChainId,
        baseFeePerGasWei,
        priorityFeePerGasWei,
      ] = await Promise.all([
        sender.chainId(),
        observer.chainId(),
        sender.latestBaseFee(),
        sender.priorityFee(),
      ]);
      if (
        senderChainId !== networkProfile.chainId ||
        observerChainId !== networkProfile.chainId
      ) {
        throw new Error(
          `Both direct RPC providers must be on ${networkProfile.name}.`,
        );
      }

      const affordable = createRequiredDirectPlan(
        baseFeePerGasWei,
        priorityFeePerGasWei,
        selectedDurationSeconds,
        networkProfile.safety.maximumSessionExposureWei,
        selectedPacketDurationMs,
        networkProfile,
        setupMode === "classic" ? "classic-per-nonce-v2" : "historical",
      );

      if (
        !affordable ||
        affordable.feePlan.affordableDurationSeconds < MIN_DURATION_SECONDS
      ) {
        throw new Error(
          `Current fees make this duration unavailable within Patio's ${formatEther(networkProfile.safety.maximumSessionExposureWei)} ${networkProfile.nativeCurrency.symbol} limit.`,
        );
      }
      // The beta has an explicit review below, populated from this fresh quote.
      // Never reuse an old approval or raise caps after wallet approval.
      if (
        !controlledTest &&
        directPlanRequiresReprepare("duration", quotedPlan, affordable)
      ) {
        setError(
          `${networkProfile.name} gas changed since the quote. The estimate has been refreshed; review it and prepare again.`,
        );
        setPreparationStage(null);
        setPhase("connected");
        return;
      }
      const { feePlan, replacementsPerWindow } = affordable;
      let fundingAmountWei = affordable.requiredFundingWei;
      const totalPackets = feePlan.windows * replacementsPerWindow;

      setPreparationStage("session");
      const account = privateKeyToAccount(generatePrivateKey());
      await controlledTest?.reserve(account.address);
      const nonceStart = await sender.latestTransactionCount(account.address);
      const descriptor: DirectSessionDescriptor = {
        version: 1,
        chainId: networkProfile.chainId,
        operator,
        sessionAddress: account.address,
        streamId: createStreamId(),
        nonceStart: nonceStart.toString(),
      };
      const recipientSnapshot = snapshotReturnRecipient(
        await sender.code(operator),
      );
      let estimatedSweepGas: bigint | undefined;
      if (recipientSnapshot.classification.kind !== "no-code") {
        const provisionalSweepValue = fundingAmountWei - feePlan.cleanupCostWei;
        if (provisionalSweepValue <= 0n) {
          throw new Error(
            "The planned session has no safe value available for return simulation.",
          );
        }
        try {
          estimatedSweepGas = await sender.estimateGas({
            from: account.address,
            to: operator,
            value: provisionalSweepValue,
            data: "0x",
            stateOverride: {
              [account.address]: {
                balance: `0x${fundingAmountWei.toString(16)}`,
              },
            },
          });
        } catch (cause) {
          throw new Error(
            `Patio cannot safely prepare a return transfer for this code-bearing operator account. ${cause instanceof Error ? cause.message : "The RPC did not support the required read-only simulation."}`,
          );
        }
      }
      const returnPlan = createPatioReturnPlan({
        recipient: operator,
        recipientSnapshot,
        feePlan,
        ...(estimatedSweepGas === undefined ? {} : { estimatedSweepGas }),
      });
      assertReturnPlanFitsNetwork(returnPlan, networkProfile);
      if (
        setupMode === "classic" &&
        returnPlan.requiredFundingWei > affordable.requiredFundingWei
      ) {
        throw new Error(
          "The code-bearing return reserve requires a new explicit review; no automatic funding increase.",
        );
      }
      fundingAmountWei = returnPlan.requiredFundingWei;
      // Keep preparation ownership/inputs locked, but don't cover the explicit
      // host review with the in-progress preparation overlay.
      if (controlledTest) setPreparationStage(null);
      const testApproval = controlledTest
        ? await controlledTest.review({
            descriptor,
            plan: affordable,
            duration: selectedDurationSeconds,
            priorityFee: priorityFeePerGasWei,
            mediaMode: mediaMode === "video" ? "video" : "audio",
            visibility,
          })
        : null;
      const classic =
        setupMode === "classic"
          ? new ClassicSession({
              attemptId: `patio-classic-${crypto.randomUUID()}`,
              account,
              operator,
              chainId: networkProfile.chainId,
              g: nonceStart,
              plan: feePlan,
              replacements: replacementsPerWindow,
              returnPlan,
              fromBlock: await sender.blockNumber(),
              clients: { read: sender, send: sender, observer },
            })
          : undefined;
      setTraceSession({
        ...descriptor,
        maxPackets: totalPackets,
        windows: feePlan.windows,
        replacementsPerWindow,
        requiredFundingWei: formatEth(fundingAmountWei),
        mediaMode,
        videoCodec: videoProfile
          ? videoProfile.codec === PatioCodec.WEBM_VP9_OPUS
            ? "WEBM_VP9_OPUS"
            : "WEBM_VP8_OPUS"
          : null,
      });
      setPreparationStage("safety");
      const commonCleanup = {
        chainId: networkProfile.chainId,
        type: "eip1559" as const,
        to: account.address,
        value: 0n,
        data: "0x" as const,
        gas: 21_000n,
        maxFeePerGas: feePlan.sealMaxFeePerGasWei,
        maxPriorityFeePerGas: feePlan.sealPriorityFeePerGasWei,
      };
      const seals: Hex[] = [];
      for (let windowIndex = 0; windowIndex < feePlan.windows; windowIndex++) {
        const tx = {
          ...commonCleanup,
          nonce: Number(nonceStart + 1n + BigInt(windowIndex)),
        };
        seals.push(
          classic
            ? await classic.sign("seal", tx, windowIndex)
            : await account.signTransaction(tx),
        );
      }
      const releaseTx = {
        ...commonCleanup,
        nonce: Number(nonceStart),
      };
      const release = classic
        ? await classic.sign("release", releaseTx)
        : await account.signTransaction(releaseTx);
      if (classic && controlledTest?.rpcConfig?.betaContext)
        controlledTest.rpcConfig.betaContext.sealHashes =
          seals.map(transactionHash);
      const correctedSweepValue =
        fundingAmountWei - returnPlan.cleanupReserveWei;
      if (correctedSweepValue <= 0n) {
        throw new Error(
          `${networkProfile.name} cleanup no longer fits the session budget.`,
        );
      }
      const sweep = classic
        ? null
        : await account.signTransaction({
            ...commonCleanup,
            to: operator,
            value: correctedSweepValue,
            gas: returnPlan.sweepGasLimit,
            nonce: Number(nonceStart + BigInt(feePlan.windows) + 1n),
          });
      if (classic) {
        descriptor.transportMode = "classic-v2";
        descriptor.classicEnd = {
          mediaNonceEnd: (classic.sweepNonce - 1n).toString(),
          releaseHash: transactionHash(release),
        };
      }
      await wait(160);
      const listener = new URL(
        directSessionUrl(window.location.origin, descriptor),
      );
      listener.searchParams.set("mode", mediaMode);
      const nextListenerUrl = listener.toString();

      const plannedSeconds = Math.floor(
        (totalPackets * selectedPacketDurationMs) / 1_000,
      );
      const announcementExpiresAt = BigInt(
        Math.floor(Date.now() / 1_000) + plannedSeconds + 900,
      );
      if (setupMode === "wallet-atomic") {
        if (!registryAddress) {
          throw new Error("The Patio public registry is not configured yet.");
        }
        setPreparationStage("registry");
        const providerSessionId = walletProviderSessionId(provider);
        const capabilities = await discoverWalletCallCapabilities({
          provider,
          providerSessionId,
          account: operator,
          chainId: networkProfile.chainId,
        });
        const approvalData = encodeFunctionData({
          abi: PATIO_REGISTRY_ABI,
          functionName: "approvedOperators",
          args: [operator],
        });
        const streamOperatorData = encodeFunctionData({
          abi: PATIO_REGISTRY_ABI,
          functionName: "streamOperators",
          args: [descriptor.streamId],
        });
        const [approvalResult, streamOperatorResult] = await Promise.all([
          sender.request<Hex>("eth_call", [
            { to: registryAddress, data: approvalData },
            "latest",
          ]),
          sender.request<Hex>("eth_call", [
            { to: registryAddress, data: streamOperatorData },
            "latest",
          ]),
        ]);
        if (!decodeRegistryOperatorApproval(approvalResult)) {
          throw new Error(
            "The connected wallet is not authorized by this PatioRegistry.",
          );
        }
        if (
          !mayUseExistingStreamOperator(
            decodeRegistryStreamOperator(streamOperatorResult),
            operator,
          )
        ) {
          throw new Error(
            "This stream ID is already owned by another registry operator.",
          );
        }
        const attemptId = `patio-atomic-${crypto.randomUUID()}`;
        const plan = createAtomicPublicSetupPlan({
          attemptId,
          providerSessionId,
          account: operator,
          chainId: networkProfile.chainId,
          descriptor,
          announcement: {
            registry: registryAddress,
            streamId: descriptor.streamId,
            sessionAddress: account.address,
            nonceStart,
            expiresAt: announcementExpiresAt,
            mediaMode:
              mediaMode === "video" || mediaMode === "video-beta" ? 1 : 0,
          },
          fundingAmountWei,
          returnPlan,
          capabilities,
          reviewedAtMs: Date.now(),
        });
        pendingAtomicSessionRef.current = {
          session: {
            networkId,
            account,
            descriptor,
            feePlan,
            replacementsPerWindow,
            totalPackets,
            seals,
            release,
            sweep,
            cleanupReserveWei: returnPlan.cleanupReserveWei,
            sweepGasLimit: returnPlan.sweepGasLimit,
            setupMode,
            listenerUrl: nextListenerUrl,
            fundingAmountWei,
            safetyMarginWei: returnPlan.safetyMarginWei,
            mediaMode,
            packetDurationMs: selectedPacketDurationMs,
            videoCodec: videoProfile?.codec ?? null,
            videoMimeType: videoProfile?.mimeType ?? null,
            visibility,
            startedAtMs: null,
            recordingEndedAtMs: null,
          },
          plan,
        };
        setAtomicSetupReview(plan);
        setAtomicSetupState("review");
        setPreparationStage(null);
        setPhase("connected");
        return;
      }

      if (!classic) throw new Error("Classic coordinator unavailable");
      const retained: PreparedDirectSession = {
        transportMode: "classic-v2",
        classic,
        networkId,
        account,
        descriptor,
        feePlan,
        replacementsPerWindow,
        totalPackets,
        seals,
        release,
        sweep: null,
        cleanupReserveWei: returnPlan.cleanupReserveWei,
        sweepGasLimit: returnPlan.sweepGasLimit,
        setupMode,
        listenerUrl: nextListenerUrl,
        fundingHash: null,
        registryHash: null,
        registryFeeWei: visibility === "public" ? null : 0n,
        setupReceiptHashes: [],
        fundingAmountWei,
        safetyMarginWei: returnPlan.safetyMarginWei,
        mediaMode,
        packetDurationMs: selectedPacketDurationMs,
        videoCodec: videoProfile?.codec ?? null,
        videoMimeType: videoProfile?.mimeType ?? null,
        visibility,
        startedAtMs: null,
        recordingEndedAtMs: null,
      };
      // Key + descriptor + reviewed plan and clients are retained BEFORE registry/funding.
      sessionRef.current = retained;
      const revalidate = async () => {
        if (controlledTest) await controlledTest.assertReady();
        else
          assertNewDirectBroadcastAllowed({
            senderRpcUrl: relayRpc.url,
            observerRpcUrl: observerRpc.url,
          });
        if (mediaMode === "audio") {
          if (!classicAudioRef.current)
            throw new Error("Microphone preflight missing");
          classicAudioRef.current.assertReady();
        }
        if (testApproval) {
          const base = await sender.latestBaseFee();
          if (
            base + testApproval.fundingTip > testApproval.fundingMaxFee ||
            base + feePlan.sealPriorityFeePerGasWei >
              feePlan.sealMaxFeePerGasWei
          )
            throw new Error(
              "Fees exceed the approved funding/close caps; no wallet request",
            );
        }
        const [senderChain, observerChain, walletChain, accounts, code] =
          await Promise.all([
            sender.chainId(),
            observer.chainId(),
            provider.request({ method: "eth_chainId" }),
            provider.request({ method: "eth_accounts" }),
            sender.code(operator),
          ]);
        if (
          senderChain !== descriptor.chainId ||
          observerChain !== descriptor.chainId ||
          Number(BigInt(String(walletChain))) !== descriptor.chainId ||
          !Array.isArray(accounts) ||
          String(accounts[0]).toLowerCase() !== operator.toLowerCase() ||
          code.toLowerCase() !== recipientSnapshot.code.toLowerCase()
        )
          throw new Error(
            "Reviewed chain/operator/return identity changed before financial action",
          );
      };
      const selectedChain = viemChainForProfile(networkProfile);
      const walletClient = createWalletClient({
        account: operator,
        chain: selectedChain,
        transport: custom(provider, { retryCount: 0 }),
      });
      setPhase("funding");
      setTraceAction("funding");
      if (visibility === "public") {
        if (!registryAddress)
          throw new Error("The Patio public registry is not configured yet.");
        setPreparationStage("registry");
        retained.registryHash = await classic.financialRequest(
          "registry",
          registryAddress,
          0n,
          revalidate,
          () =>
            walletClient.writeContract({
              account: operator,
              address: registryAddress,
              abi: PATIO_REGISTRY_ABI,
              functionName: "announce",
              args: [
                descriptor.streamId,
                account.address,
                nonceStart,
                announcementExpiresAt,
                mediaMode === "video" || mediaMode === "video-beta" ? 1 : 0,
              ],
              chain: selectedChain,
            }),
        );
        setExecutionProof((current) => ({
          ...current,
          registryHash: retained.registryHash,
        }));
        retained.registryFeeWei = classicReceiptFee(
          await classic.confirmFinancial("registry", 60),
        );
      }
      setPreparationStage("funding");
      retained.fundingHash = await classic.financialRequest(
        "funding",
        account.address,
        fundingAmountWei,
        revalidate,
        () =>
          walletClient.sendTransaction({
            account: operator,
            chain: selectedChain,
            to: account.address,
            value: fundingAmountWei,
            ...(testApproval
              ? {
                  gas: 21_000n,
                  maxFeePerGas: testApproval.fundingMaxFee,
                  maxPriorityFeePerGas: testApproval.fundingTip,
                  type: "eip1559" as const,
                }
              : {}),
          }),
      );
      setExecutionProof((current) => ({
        ...current,
        fundingHash: retained.fundingHash,
      }));
      await classic.reconcileFunding(60);
      localStorage.setItem(DIRECT_SESSION_STORAGE_KEY, nextListenerUrl);
      sequenceRef.current = 0;
      videoSegmentIndexRef.current = 0;
      webmInitializationRef.current = null;
      videoBootstrapRef.current = null;
      setPacketCount(0);
      setSegmentCount(0);
      setMediaBytes(0);
      setSeconds(0);
      setPlannedDurationSeconds(plannedSeconds);
      setListenerUrl(nextListenerUrl);
      setTraceAction("media");
      setPreparationStage(null);
      setPhase("ready");
      void refreshBalance();
    } catch (cause) {
      const presented = presentWalletError(
        cause,
        "Direct session setup failed.",
      );
      setError(presented.message);
      setErrorDetails(presented.details);
      setPreparationStage(null);
      if (sessionRef.current) {
        setError(
          `${presented.message} Session retained. Keep this tab open; use read-only reconciliation, not Prepare again.`,
        );
        setPhase("held");
      } else setPhase("connected");
    } finally {
      prepareBusyRef.current = false;
    }
  };

  const confirmAtomicSetup = async (): Promise<void> => {
    const pending = pendingAtomicSessionRef.current;
    const provider =
      wallet?.provider ?? discoverInjectedProvider(browserWalletHost());
    if (!pending || !atomicSetupReview || !provider || !operator) {
      setError("Prepare the atomic setup review again before confirming it.");
      return;
    }
    if (atomicDispatchingRef.current) return;
    atomicDispatchingRef.current = true;
    setError(null);
    setErrorDetails(null);
    try {
      assertNewDirectBroadcastAllowed({
        senderRpcUrl: relayRpc.url,
        observerRpcUrl: observerRpc.url,
      });
      const { plan, session } = pending;
      if (
        plan.attemptId !== atomicSetupReview.attemptId ||
        plan.account.toLowerCase() !== operator.toLowerCase() ||
        plan.chainId !== networkProfile.chainId
      ) {
        throw new Error(
          "The reviewed atomic setup no longer matches this wallet connection.",
        );
      }
      const sender = new BrowserEthereumRpc(relayRpc);
      const approvalData = encodeFunctionData({
        abi: PATIO_REGISTRY_ABI,
        functionName: "approvedOperators",
        args: [operator],
      });
      const streamOperatorData = encodeFunctionData({
        abi: PATIO_REGISTRY_ABI,
        functionName: "streamOperators",
        args: [session.descriptor.streamId],
      });
      const [
        chainId,
        baseFeePerGasWei,
        currentOperatorCode,
        sessionCode,
        sessionNonce,
        approvalResult,
        streamOperatorResult,
      ] = await Promise.all([
        sender.chainId(),
        sender.latestBaseFee(),
        sender.code(operator),
        sender.code(session.descriptor.sessionAddress),
        sender.latestTransactionCount(session.descriptor.sessionAddress),
        sender.request<Hex>("eth_call", [
          { to: plan.announcement.registry, data: approvalData },
          "latest",
        ]),
        sender.request<Hex>("eth_call", [
          { to: plan.announcement.registry, data: streamOperatorData },
          "latest",
        ]),
      ]);
      if (chainId !== plan.chainId) {
        throw new Error(
          "The configured direct RPC changed networks; review setup again.",
        );
      }
      if (baseFeePerGasWei > session.feePlan.baseFeePerGasWei) {
        throw new Error(
          "Network fees changed after review; prepare a fresh atomic setup plan.",
        );
      }
      if (
        currentOperatorCode.toLowerCase() !==
        plan.returnPlan.recipientCode.toLowerCase()
      ) {
        throw new Error(
          "The operator account code changed after review; prepare a fresh return plan.",
        );
      }
      if (plan.returnPlan.recipientCodeKind !== "no-code") {
        const refreshedEstimate = await sender.estimateGas({
          from: session.descriptor.sessionAddress,
          to: operator,
          value: session.fundingAmountWei - plan.returnPlan.cleanupReserveWei,
          data: "0x",
          stateOverride: {
            [session.descriptor.sessionAddress]: {
              balance: `0x${session.fundingAmountWei.toString(16)}`,
            },
          },
        });
        const refreshedReturnPlan = createPatioReturnPlan({
          recipient: operator,
          recipientSnapshot: snapshotReturnRecipient(currentOperatorCode),
          feePlan: session.feePlan,
          estimatedSweepGas: refreshedEstimate,
        });
        if (
          refreshedReturnPlan.sweepGasLimit > plan.returnPlan.sweepGasLimit ||
          refreshedReturnPlan.requiredFundingWei > session.fundingAmountWei
        ) {
          throw new Error(
            "The code-bearing return path changed after review; prepare setup again.",
          );
        }
      }
      if (
        sessionCode !== "0x" ||
        sessionNonce !== BigInt(session.descriptor.nonceStart)
      ) {
        throw new Error(
          "The prepared session is no longer a fresh plain EOA; do not dispatch setup.",
        );
      }
      if (
        plan.announcement.expiresAt <= BigInt(Math.floor(Date.now() / 1_000))
      ) {
        throw new Error(
          "The announcement review expired; prepare setup again.",
        );
      }
      if (!decodeRegistryOperatorApproval(approvalResult)) {
        throw new Error(
          "Registry operator authorization changed after review; do not dispatch.",
        );
      }
      if (
        !mayUseExistingStreamOperator(
          decodeRegistryStreamOperator(streamOperatorResult),
          operator,
        )
      ) {
        throw new Error(
          "Registry stream ownership changed after review; do not dispatch.",
        );
      }
      reserveAtomicSetupAttempt(localStorage, {
        id: plan.attemptId,
        providerSessionId: plan.providerSessionId,
        account: plan.account,
        chainId: plan.chainId,
        sessionAddress: session.descriptor.sessionAddress,
        streamId: session.descriptor.streamId,
        requestedFundingWei: session.fundingAmountWei,
        state: "dispatching",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      setPhase("funding");
      setPreparationStage("funding");
      const result = await dispatchReviewedWalletCallBatch({
        plan: plan.walletCallPlan,
        provider,
        providerSessionId: plan.providerSessionId,
        connectedAccount: operator,
        connectedChainId: networkProfile.chainId,
        networkEnabled: true,
        explicitAuthorization: true,
      });
      if (result.kind === "rejected") {
        updateAtomicSetupAttempt(localStorage, plan.attemptId, {
          state: "rejected",
          updatedAtMs: Date.now(),
          detail: result.reason,
        });
        setPhase("connected");
        setPreparationStage(null);
        setError(
          "Atomic wallet setup was rejected. No classic funding was sent.",
        );
        return;
      }
      if (result.kind !== "submitted") {
        const state = result.kind === "uncertain" ? "uncertain" : "held";
        updateAtomicSetupAttempt(localStorage, plan.attemptId, {
          state,
          updatedAtMs: Date.now(),
          detail: result.reason,
        });
        setAtomicSetupState(
          state === "held" ? "held" : "awaiting-verification",
        );
        setPhase("connected");
        setPreparationStage(null);
        setError(
          result.kind === "uncertain"
            ? "Atomic setup outcome is uncertain. Reconcile it before attempting another setup."
            : result.reason,
        );
        return;
      }
      updateAtomicSetupAttempt(localStorage, plan.attemptId, {
        state: "submitted",
        updatedAtMs: Date.now(),
        ...(result.record.walletBatchId === undefined
          ? {}
          : { walletBatchId: result.record.walletBatchId }),
      });
      atomicBatchRecordRef.current = result.record;
      const status = await readWalletCallBatchStatus({
        record: result.record,
        provider,
        providerSessionId: plan.providerSessionId,
        connectedAccount: operator,
        connectedChainId: plan.chainId,
      });
      if (status.kind !== "updated" || status.record.state === "pending") {
        setAtomicSetupState("awaiting-verification");
        setPhase("connected");
        setPreparationStage(null);
        setError(
          "Atomic setup is awaiting wallet and canonical verification. It will not start media yet.",
        );
        return;
      }
      const walletReadiness = assessAtomicSetupReadiness({
        walletState: status.record.state,
        atomicReported: status.record.atomicReported,
        atomicityInconsistent: status.record.atomicityInconsistent,
        canonicalReceiptCount: status.record.receipts.length,
        allCanonicalReceiptsSuccessful: false,
      });
      if (walletReadiness.readiness === "held") {
        updateAtomicSetupAttempt(localStorage, plan.attemptId, {
          state: "held",
          updatedAtMs: Date.now(),
          detail: walletReadiness.reason,
        });
        setAtomicSetupState("held");
        setPhase("connected");
        setPreparationStage(null);
        setError(walletReadiness.reason);
        return;
      }
      const receiptHashes = status.record.receipts.map(
        (receipt) => receipt.transactionHash,
      );
      if (receiptHashes.length === 0) {
        setAtomicSetupState("awaiting-verification");
        setPhase("connected");
        setPreparationStage(null);
        setError(
          "Wallet success needs canonical receipt references before Patio can verify setup.",
        );
        return;
      }
      const canonicalReceipts = await Promise.all(
        receiptHashes.map((hash) => sender.receipt(hash)),
      );
      if (
        canonicalReceipts.some(
          (receipt) => !receipt || BigInt(receipt.status) !== 1n,
        )
      ) {
        throw new Error(
          "Atomic setup receipts are not all canonically successful yet.",
        );
      }
      const [broadcasts, fundedBalance, finalSessionCode, finalSessionNonce] =
        await Promise.all([
          fetchPublicBroadcasts(
            sender,
            plan.announcement.registry,
            plan.chainId,
          ),
          sender.balance(session.descriptor.sessionAddress),
          sender.code(session.descriptor.sessionAddress),
          sender.latestTransactionCount(session.descriptor.sessionAddress),
        ]);
      const announced = broadcasts.find(
        (broadcast) =>
          broadcast.descriptor.streamId.toLowerCase() ===
            session.descriptor.streamId.toLowerCase() &&
          broadcast.descriptor.operator.toLowerCase() ===
            operator.toLowerCase() &&
          broadcast.descriptor.sessionAddress.toLowerCase() ===
            session.descriptor.sessionAddress.toLowerCase() &&
          broadcast.descriptor.nonceStart === session.descriptor.nonceStart &&
          broadcast.mediaMode ===
            (plan.announcement.mediaMode === 1 ? "video" : "audio") &&
          broadcast.expiresAt >= Number(plan.announcement.expiresAt),
      );
      const canonicalReadiness = assessAtomicSetupReadiness({
        walletState: status.record.state,
        atomicReported: status.record.atomicReported,
        atomicityInconsistent: status.record.atomicityInconsistent,
        canonicalReceiptCount: receiptHashes.length,
        allCanonicalReceiptsSuccessful: true,
        exactAnnouncementObserved: Boolean(announced),
        announcementStillValid: announced
          ? announced.expiresAt > Math.floor(Date.now() / 1_000)
          : undefined,
        sufficientSessionBalance: fundedBalance >= session.fundingAmountWei,
        sessionIsFreshPlainEoa:
          finalSessionCode === "0x" &&
          finalSessionNonce === BigInt(session.descriptor.nonceStart),
      });
      if (canonicalReadiness.readiness !== "verified") {
        if (canonicalReadiness.readiness === "awaiting-verification") {
          setAtomicSetupState("awaiting-verification");
          setPhase("connected");
          setPreparationStage(null);
          setError(canonicalReadiness.reason);
          return;
        }
        throw new Error(canonicalReadiness.reason);
      }
      sessionRef.current = {
        ...session,
        fundingHash: null,
        registryHash: null,
        registryFeeWei: null,
        setupReceiptHashes: receiptHashes,
      };
      updateAtomicSetupAttempt(localStorage, plan.attemptId, {
        state: "verified",
        updatedAtMs: Date.now(),
        ...(result.record.walletBatchId === undefined
          ? {}
          : { walletBatchId: result.record.walletBatchId }),
      });
      pendingAtomicSessionRef.current = null;
      setAtomicSetupReview(null);
      setAtomicSetupState(null);
      localStorage.setItem(DIRECT_SESSION_STORAGE_KEY, session.listenerUrl);
      sequenceRef.current = 0;
      videoSegmentIndexRef.current = 0;
      webmInitializationRef.current = null;
      videoBootstrapRef.current = null;
      setPacketCount(0);
      setSegmentCount(0);
      setMediaBytes(0);
      setSeconds(0);
      setPlannedDurationSeconds(
        Math.floor((session.totalPackets * session.packetDurationMs) / 1_000),
      );
      setListenerUrl(session.listenerUrl);
      setTraceAction("media");
      setPreparationStage(null);
      setPhase("ready");
      void refreshBalance();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Atomic setup verification failed.";
      const pendingPlan = pendingAtomicSessionRef.current?.plan;
      if (pendingPlan) {
        try {
          updateAtomicSetupAttempt(localStorage, pendingPlan.attemptId, {
            state: "held",
            updatedAtMs: Date.now(),
            detail: message,
          });
        } catch {
          // The original persisted attempt remains safer than erasing it.
        }
      }
      setAtomicSetupState("held");
      setPhase("connected");
      setPreparationStage(null);
      setError(message);
    } finally {
      atomicDispatchingRef.current = false;
    }
  };

  /** User-triggered, read-only status reconciliation. It never resubmits. */
  const reconcileAtomicSetup = async (): Promise<void> => {
    const pending = pendingAtomicSessionRef.current;
    const record = atomicBatchRecordRef.current;
    const provider =
      wallet?.provider ?? discoverInjectedProvider(browserWalletHost());
    if (!pending || !record || !provider || !operator) {
      setError(
        "This setup attempt can only be reconciled while its session remains in this tab. No session key is restored from local metadata.",
      );
      return;
    }
    try {
      const result = await readWalletCallBatchStatus({
        record,
        provider,
        providerSessionId: pending.plan.providerSessionId,
        connectedAccount: operator,
        connectedChainId: pending.plan.chainId,
      });
      if (result.kind !== "updated") {
        setError(result.reason);
        return;
      }
      atomicBatchRecordRef.current = result.record;
      if (result.record.state === "pending") {
        setAtomicSetupState("awaiting-verification");
        setError(
          "Atomic setup remains pending. Patio will not start media until canonical setup checks pass.",
        );
        return;
      }
      setAtomicSetupState("held");
      setError(
        result.record.state === "included"
          ? "Wallet inclusion evidence changed. Re-open this reviewed setup only after its canonical registry and funding evidence has been checked."
          : "Atomic setup did not reach a verified successful state. It remains held; Patio will not resend it.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Atomic setup reconciliation is unavailable.",
      );
    }
  };

  const finishSession = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || cleanupStartedRef.current) return;
    cleanupStartedRef.current = true;
    setPhase("cleaning");
    if (session.transportMode === "classic-v2" && session.classic) {
      const classic = session.classic;
      try {
        classic.beginCleanup(); // queue has drained; no media signature can follow
        await controlledTest?.freeze();
        const { send: sender, observer } = classic.input.clients;
        for (const [index, seal] of session.seals.entries()) {
          const nonce = classic.input.g + 1n + BigInt(index);
          if (
            (await sender.latestTransactionCount(session.account.address)) >
            nonce
          )
            continue;
          const hash = await classic.send(seal);
          setExecutionProof((current) => ({ ...current, sealHash: hash }));
          await waitForObserver(
            observer,
            session.account.address,
            hash,
            undefined,
            {
              account: session.account.address,
              chainId: session.descriptor.chainId,
              nonce,
              maxFee: session.feePlan.sealMaxFeePerGasWei,
              tip: session.feePlan.sealPriorityFeePerGasWei,
            },
          );
        }
        if (
          (await sender.latestTransactionCount(session.account.address)) ===
          classic.input.g
        ) {
          const hash = await classic.send(session.release);
          setExecutionProof((current) => ({ ...current, releaseHash: hash }));
        }
        setClassicResult(
          "Classic close pending canonical verification. A seal observation does not exclude older media.",
        );
        await classic.reconcile(60);
        setClassicResult(
          `Classic nonces consumed; ${classic.mediaIncluded.size} known media included. Returning remaining balance.`,
        );
        const sweepHash = await classic.sweep();
        if (sweepHash) {
          setExecutionProof((current) => ({ ...current, sweepHash }));
          await classic.confirmSweep(60);
        }
        const knownFees = [...classic.receipts.values()].map(classicReceiptFee);
        const gas = knownFees.some((fee) => fee === null)
          ? null
          : knownFees.reduce<bigint>((sum, fee) => sum + fee!, 0n);
        setClassicResult(
          `Classic closure reconciled (included, not finalized). Media inclusion: ${classic.mediaIncluded.size}. Session gas: ${gas === null ? "Unknown" : formatEther(gas)} ETH. Confirmed return: ${classic.returned === null ? "Unknown / no sweep" : formatEther(classic.returned)} ETH. Observed residual: ${classic.residual === null ? "Unknown" : formatEther(classic.residual)} ETH. Operator funding/registry gas is separate.${classic.mediaIncluded.size ? " Media-inclusion incident remains recorded." : " No known media included in checked canonical receipts."}`,
        );
        for (const signature of classic.signatures)
          diagnostics.record(
            "cleanup-stage",
            {
              role: signature.role,
              hash: signature.hash,
              nonce: signature.nonce.toString(),
              status: signature.outcome,
              stage: "classic-reconciled",
            },
            diagnosticsTokenRef.current,
          );
        diagnostics.record(
          "session-end",
          {
            status: classic.mediaIncluded.size
              ? "classic-media-inclusion-incident"
              : "classic-close-and-return-reconciled",
          },
          diagnosticsTokenRef.current,
        );
        saveClassicHistory(session);
        setTraceAction("done");
        // A non-transferable residual is held, not labelled fully returned.
        setPhase(sweepHash ? "ended" : "held");
      } catch (cause) {
        classic.held = true;
        setClassicResult(
          `Classic session held. Known media included: ${classic.mediaIncluded.size}. Return unconfirmed. Keep this tab open; reconciliation is read-only.`,
        );
        setError(
          cause instanceof Error ? cause.message : "Classic closure uncertain",
        );
        setPhase("held");
      }
      return; // latch retained, never enter legacy cleanup or automatic retry
    }
    if (session.transportMode === "single-nonce-retirement-v1") {
      try {
        await session.transport.stop();
        for (const event of session.transport.snapshot().events) {
          diagnostics.record(
            "cleanup-stage",
            event,
            diagnosticsTokenRef.current,
          );
        }
        diagnostics.record(
          "session-end",
          { status: "canonical-retirement-and-sweep" },
          diagnosticsTokenRef.current,
        );
        setPhase("ended");
      } catch (cause) {
        for (const event of session.transport.snapshot().events) {
          diagnostics.record(
            "cleanup-stage",
            event,
            diagnosticsTokenRef.current,
          );
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Private retirement held; no retry.",
        );
        setPhase("held");
      }
      // Keep the latch: an uncertain close must never re-enter any cleanup/send path.
      return;
    }
    setError(
      "Legacy pre-signed cleanup retained. No migration or retry is authorized; keep this tab open for reconciliation.",
    );
    setPhase("held");
    return;
  }, [diagnostics, controlledTest]);

  const sendMediaPayload = useCallback(
    async (
      payload: Uint8Array,
      type: PatioPacketType,
      codec: PatioCodec,
      capturedAtMs: bigint,
    ): Promise<void> => {
      const session = sessionRef.current;
      if (!session) throw new Error("No prepared direct Patio session.");
      const sequence = sequenceRef.current;
      if (session.transportMode === "single-nonce-retirement-v1") {
        diagnostics.record(
          "packet-send-attempt",
          {
            sequence,
            windowIndex: 0,
            replacementIndex: sequence,
            bytes: payload.length + 76,
          },
          diagnosticsTokenRef.current,
        );
        const hash = await session.transport.sendMedia(
          payload,
          type,
          codec,
          capturedAtMs,
        );
        const record = session.transport
          .snapshot()
          .signatures.find((item) => item.hash === hash)!;
        updateReplacementLineage((current) =>
          addMediaReplacementCandidate(current, {
            hash,
            nonce: BigInt(record.nonce),
            windowIndex: 0,
            sequence,
            replacementIndex: sequence,
            maxFeePerGasWei: BigInt(record.maxFee),
            maxPriorityFeePerGasWei: BigInt(record.tip),
            submittedAtMs: Date.now(),
          }),
        );
        updateReplacementLineage((current) =>
          markPatioReplacementObserved(current, hash),
        );
        diagnostics.record(
          "packet-send-result",
          { hash, sequence, outcome: "accepted" },
          diagnosticsTokenRef.current,
        );
        diagnostics.record(
          "packet-observed",
          { hash, sequence },
          diagnosticsTokenRef.current,
        );
        if (session.mediaMode === "video")
          await new Promise((resolve) =>
            setTimeout(resolve, DIRECT_VIDEO_PACKET_DWELL_MS),
          );
        sequenceRef.current++;
        setPacketCount(sequenceRef.current);
        if (sequenceRef.current >= session.totalPackets) stopRecorder();
        return;
      }
      if (sequence >= session.totalPackets) {
        diagnostics.record(
          "budget-exhausted",
          { sequence },
          diagnosticsTokenRef.current,
        );
        throw new Error("The fee-safe Patio packet budget is exhausted.");
      }
      const windowIndex = Math.floor(sequence / session.replacementsPerWindow);
      const replacementIndex = sequence % session.replacementsPerWindow;
      const envelope = encodePatioPacket({
        version: 1,
        type,
        codec,
        flags: 0,
        streamId: session.descriptor.streamId,
        windowIndex,
        sequence,
        capturedAtMs,
        payload,
      });
      const nonce =
        BigInt(session.descriptor.nonceStart) + 1n + BigInt(windowIndex);
      const maxFeePerGasWei =
        session.feePlan.mediaFeeLadderWei[replacementIndex] ??
        session.feePlan.sealMaxFeePerGasWei;
      const maxPriorityFeePerGasWei =
        session.feePlan.mediaPriorityFeeLadderWei[replacementIndex] ??
        session.feePlan.sealPriorityFeePerGasWei;
      const classic = session.classic;
      if (session.transportMode !== "classic-v2" || !classic)
        throw new Error("Legacy media signing disabled; no session migration");
      const rawTransaction = await classic.sign(
        "media",
        {
          chainId: session.descriptor.chainId,
          type: "eip1559",
          to: session.account.address,
          value: 0n,
          data: bytesToHex(envelope),
          gas: MEDIA_TRANSACTION_GAS,
          nonce: Number(nonce),
          maxFeePerGas: maxFeePerGasWei,
          maxPriorityFeePerGas: maxPriorityFeePerGasWei,
        },
        sequence,
      );
      const { observer } = classic.input.clients;
      // The signing slot is consumed now, not when a later observer read works.
      // Never let a queued chunk reuse an already signed index.
      sequenceRef.current = sequence + 1;
      setTraceAction("media");
      const expectedHash = transactionHash(rawTransaction);
      updateReplacementLineage((current) =>
        addMediaReplacementCandidate(current, {
          hash: expectedHash,
          nonce,
          windowIndex,
          sequence,
          replacementIndex,
          maxFeePerGasWei,
          maxPriorityFeePerGasWei,
          submittedAtMs: Date.now(),
        }),
      ); // signed inventory and lineage exist even if submission times out
      const sendStartedAt = performance.now();
      diagnostics.record(
        "packet-send-attempt",
        {
          hash: expectedHash,
          sequence,
          windowIndex,
          replacementIndex,
          bytes: envelope.length,
        },
        diagnosticsTokenRef.current,
      );
      let hash: Hex;
      try {
        hash = await classic.send(rawTransaction);
      } finally {
        diagnostics.record(
          "packet-send-result",
          {
            hash: expectedHash,
            sequence,
            outcome:
              classic.signatures.find((s) => s.hash === expectedHash)
                ?.outcome ?? "uncertain",
            bytes: envelope.length,
            durationMs: performance.now() - sendStartedAt,
          },
          diagnosticsTokenRef.current,
        );
      }
      updateReplacementLineage((current) =>
        addMediaReplacementCandidate(current, {
          hash,
          nonce,
          windowIndex,
          sequence,
          replacementIndex,
          maxFeePerGasWei,
          maxPriorityFeePerGasWei,
          submittedAtMs: Date.now(),
        }),
      );
      setExecutionProof((current) => ({ ...current, lastMediaHash: hash }));
      // Advisory diagnostics must not serialize an extra RPC round-trip into
      // every recorder chunk. At most one snapshot in flight; no retry, no
      // effect on the mandatory seal observation or financial close guards.
      if (!mediaObservationRef.current) {
        const token = diagnosticsTokenRef.current;
        const observationStarted = performance.now();
        const pending = observeClassicMedia(
          observer,
          session.account.address,
          hash,
        )
          .then((observation) => {
            if (sessionRef.current !== session || diagnostics.token() !== token)
              return;
            diagnostics.record(
              observation === "read-failed" ? "poll-error" : "poll-complete",
              {
                hash,
                sequence,
                durationMs: performance.now() - observationStarted,
                pollAttempt: 1,
                status: observation,
              },
              token,
            );
            if (observation === "observed") {
              diagnostics.record(
                "packet-observed",
                {
                  hash,
                  sequence,
                  durationMs: performance.now() - observationStarted,
                },
                token,
              );
              updateReplacementLineage((current) =>
                markPatioReplacementObserved(current, hash),
              );
            }
          })
          .finally(() => {
            if (mediaObservationRef.current === pending)
              mediaObservationRef.current = null;
          });
        mediaObservationRef.current = pending;
      }
      if (
        session.mediaMode === "video" ||
        controlledTest?.mode === "hoodi-beta"
      ) {
        // txpool_contentFrom is a snapshot, not a replayable feed. Keep each
        // acknowledged replacement briefly available, including the last
        // audio packet before a seal. This is not a delivery guarantee/ACK.
        diagnostics.record(
          "replacement-dwell",
          {
            sequence,
            durationMs: DIRECT_VIDEO_PACKET_DWELL_MS,
            reason: "listener-poll-visibility",
          },
          diagnosticsTokenRef.current,
        );
        await wait(DIRECT_VIDEO_PACKET_DWELL_MS);
      }
      setPacketCount(sequenceRef.current);
      const completedWindow =
        replacementIndex + 1 === session.replacementsPerWindow;
      if (completedWindow && sequenceRef.current < session.totalPackets) {
        const seal = session.seals[windowIndex];
        if (!seal) throw new Error("Missing pre-signed window seal.");
        const sealHash = await classic.send(seal);
        updateReplacementLineage((current) =>
          addPatioEmptySealCandidate(current, {
            hash: sealHash,
            nonce,
            windowIndex,
            maxFeePerGasWei: session.feePlan.sealMaxFeePerGasWei,
            maxPriorityFeePerGasWei: session.feePlan.sealPriorityFeePerGasWei,
            submittedAtMs: Date.now(),
          }),
        );
        setExecutionProof((current) => ({ ...current, sealHash }));
        await waitForObserver(
          observer,
          session.account.address,
          sealHash,
          undefined,
          {
            account: session.account.address,
            chainId: session.descriptor.chainId,
            nonce,
            maxFee: session.feePlan.sealMaxFeePerGasWei,
            tip: session.feePlan.sealPriorityFeePerGasWei,
          },
        );
        updateReplacementLineage((current) =>
          markPatioReplacementObserved(current, sealHash),
        );
      }
      setTraceAction("media");
      if (sequenceRef.current >= session.totalPackets) stopRecorder();
    },
    [controlledTest, diagnostics, stopRecorder, updateReplacementLineage],
  );

  const processMediaChunk = useCallback(
    async (
      blob: Blob,
      metric: { chunkId: string; token: number },
    ): Promise<void> => {
      const session = sessionRef.current;
      if (!session) throw new Error("No prepared direct Patio session.");
      const recordedBytes = new Uint8Array(await blob.arrayBuffer());
      if (session.transportMode === "classic-v2" && session.classic?.frozen) {
        diagnostics.record(
          "media-drop",
          { bytes: recordedBytes.length, reason: "classic-media-frozen" },
          metric.token,
        );
        return;
      }
      if (recordedBytes.length === 0) return;

      if (
        session.transportMode === "single-nonce-retirement-v1" &&
        session.transport.snapshot().state !== "broadcasting" &&
        sequenceRef.current < session.totalPackets
      ) {
        diagnostics.record(
          "media-drop",
          {
            chunkId: metric.chunkId,
            bytes: recordedBytes.length,
            reason: "retirement-media-permanently-frozen",
          },
          metric.token,
        );
        return;
      }

      const capacity = mediaCapacityDecision(
        sequenceRef.current,
        session.totalPackets,
      );
      if (!capacity.allowed) {
        diagnostics.record(
          "budget-exhausted",
          {
            sequence: sequenceRef.current,
            reason: "trailing-chunk-outside-authorized-capacity",
          },
          metric.token,
        );
        diagnostics.record(
          "recorder-tail-discarded",
          {
            chunkId: metric.chunkId,
            bytes: recordedBytes.length,
            reason: capacity.reason,
          },
          metric.token,
        );
        return;
      }

      if (session.mediaMode === "video") {
        const segmentIndex = videoSegmentIndexRef.current;
        const seekableVideo = makeWebmVideoChunkBootstrapped(
          recordedBytes,
          videoBootstrapRef.current,
        );
        videoBootstrapRef.current = seekableVideo.bootstrapSegment;
        if (!seekableVideo.bootstrapSegment || !seekableVideo.resyncable) {
          throw new Error("Chrome did not produce a playable WebM bootstrap.");
        }
        const transportPayload = frameWebmTransportPayload(
          seekableVideo.payload,
          seekableVideo.prefixLength,
        );
        const fragments = fragmentVideoSegment(
          transportPayload,
          segmentIndex,
          seekableVideo.resyncable,
        );
        const remainingPackets = session.totalPackets - sequenceRef.current;
        if (fragments.length > remainingPackets) {
          diagnostics.record(
            "media-drop",
            {
              chunkId: metric.chunkId,
              bytes: recordedBytes.length,
              fragmentCount: fragments.length,
              reason: "packet-budget-insufficient",
            },
            metric.token,
          );
          stopRecorder();
          return;
        }
        diagnostics.record(
          "segment-framed",
          {
            chunkId: metric.chunkId,
            segmentIndex,
            bytes: recordedBytes.length,
            transportBytes: transportPayload.length,
            fragmentCount: fragments.length,
          },
          metric.token,
        );
        const capturedAtMs = BigInt(Date.now());
        for (const payload of fragments) {
          await sendMediaPayload(
            payload,
            seekableVideo.resyncable
              ? PatioPacketType.START
              : PatioPacketType.VIDEO,
            session.videoCodec ?? PatioCodec.WEBM_VP8_OPUS,
            capturedAtMs,
          );
        }
        videoSegmentIndexRef.current += 1;
        setSegmentCount(videoSegmentIndexRef.current);
        setMediaBytes((current) => current + recordedBytes.length);
        return;
      }

      const seekableAudio = makeWebmChunkSeekable(
        recordedBytes,
        webmInitializationRef.current,
      );
      webmInitializationRef.current = seekableAudio.initializationSegment;
      if (!seekableAudio.initializationSegment) {
        throw new Error("Chrome did not produce WebM initialization data.");
      }
      const framedAudio = frameWebmAudioPayload(
        seekableAudio.payload,
        seekableAudio.resyncable
          ? seekableAudio.initializationSegment.length
          : 0,
      );
      diagnostics.record(
        "segment-framed",
        {
          chunkId: metric.chunkId,
          bytes: recordedBytes.length,
          transportBytes: framedAudio.length,
          fragmentCount: 1,
        },
        metric.token,
      );
      await sendMediaPayload(
        framedAudio,
        seekableAudio.resyncable
          ? PatioPacketType.START
          : PatioPacketType.AUDIO,
        PatioCodec.OPUS_WEBM,
        BigInt(Date.now()),
      );
      setMediaBytes((current) => current + recordedBytes.length);
    },
    [diagnostics, sendMediaPayload, stopRecorder],
  );

  const startBroadcast = async (): Promise<void> => {
    if (cancelBusyRef.current) return;
    const audioInput =
      privatePrepared?.mediaMode === "audio"
        ? privatePrepared.audioInput
        : !privatePrepared && sessionRef.current?.mediaMode === "audio"
          ? (classicAudioRef.current ?? undefined)
          : undefined;
    if (
      privateStartBusyRef.current ||
      recorderRef.current?.state === "recording" ||
      recorderRef.current?.state === "paused"
    )
      return;
    if (!sessionRef.current) {
      setError(`Prepare the ${networkProfile.name} broadcast first.`);
      return;
    }
    setError(null);
    setErrorDetails(null);
    const preparedSession = sessionRef.current;
    const requiredMediaType =
      preparedSession.mediaMode === "video"
        ? preparedSession.videoMimeType
        : PATIO_MEDIA_TYPE;
    if (
      typeof MediaRecorder === "undefined" ||
      !requiredMediaType ||
      !MediaRecorder.isTypeSupported(requiredMediaType)
    ) {
      setError("Use desktop Chrome to broadcast Patio media.");
      return;
    }
    privateStartBusyRef.current = true;
    let acquiredAudio: MediaStream | undefined;
    let detachAudioEnded: (() => void) | undefined;
    let captureStarted = false;
    try {
      const wantsVideo = preparedSession.mediaMode === "video";
      if (
        preparedSession.transportMode === "classic-v2" &&
        (!preparedSession.classic ||
          preparedSession.classic.frozen ||
          preparedSession.classic.held ||
          preparedSession.classic.financial.find(
            (entry) => entry.role === "funding",
          )?.state !== "confirmed")
      )
        throw new Error("Retained classic session is not ready for capture");
      if (
        preparedSession.startedAtMs !== null ||
        (preparedSession.transportMode === "single-nonce-retirement-v1" &&
          preparedSession.transport.snapshot().state !== "prepared")
      )
        throw new Error("This retained session cannot start another capture.");
      if (preparedSession.transportMode === "classic-v2")
        preparedSession.classic?.claimCapture();
      const mediaStream = audioInput
        ? (acquiredAudio = audioInput.takeForCapture())
        : await navigator.mediaDevices.getUserMedia(
            mediaConstraints(wantsVideo),
          );
      if (wantsVideo && videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = mediaStream;
        await videoPreviewRef.current.play();
      }
      const recorder = new MediaRecorder(
        mediaStream,
        audioInput
          ? patioAudioOptions()
          : mediaRecorderOptions(wantsVideo, requiredMediaType),
      );
      const diagnosticsToken = diagnostics.begin(
        {
          chainId: preparedSession.descriptor.chainId,
          sessionAddress: preparedSession.descriptor.sessionAddress,
          streamId: preparedSession.descriptor.streamId,
        },
        {
          mediaMode: preparedSession.mediaMode,
          recorderTimesliceMs: preparedSession.packetDurationMs,
          broadcasterObserverPollIntervalMs:
            DIRECT_BROADCAST_OBSERVER_POLL_INTERVAL_MS,
          videoPacketDwellMs:
            preparedSession.mediaMode === "video"
              ? DIRECT_VIDEO_PACKET_DWELL_MS
              : 0,
          codec: requiredMediaType,
        },
      );
      diagnosticsTokenRef.current = diagnosticsToken;
      mediaChunkIdRef.current = 0;
      previousRecorderTimecodeRef.current = null;
      processingRef.current = Promise.resolve();
      queuedMediaChunksRef.current = 0;
      stopRequestedRef.current = false;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) return;
        const chunkId = `chunk-${++mediaChunkIdRef.current}`;
        const previousTimecode = previousRecorderTimecodeRef.current;
        const contentDurationMs =
          Number.isFinite(event.timecode) && previousTimecode !== null
            ? Math.max(0, event.timecode - previousTimecode)
            : null;
        if (Number.isFinite(event.timecode)) {
          previousRecorderTimecodeRef.current = event.timecode;
        }
        queuedMediaChunksRef.current += 1;
        diagnostics.record(
          "recorder-data",
          {
            chunkId,
            bytes: event.data.size,
            ...(contentDurationMs === null ? {} : { contentDurationMs }),
          },
          diagnosticsToken,
        );
        diagnostics.record(
          "queue-enter",
          {
            chunkId,
            bytes: event.data.size,
            depth: queuedMediaChunksRef.current,
          },
          diagnosticsToken,
        );
        processingRef.current = processingRef.current
          .then(() =>
            processMediaChunk(event.data, {
              chunkId,
              token: diagnosticsToken,
            }),
          )
          .catch((cause: unknown) => {
            // Retain the FIRST failure and discard subsequent queued media.
            // Otherwise a swallowed queue error used to retry the signed slot
            // and replace the real cause with "Signing slot unavailable".
            if (preparedSession.transportMode === "classic-v2")
              preparedSession.classic?.freeze();
            diagnostics.record(
              "error",
              { errorClass: "media-processing", reason: "chunk-failed" },
              diagnosticsToken,
            );
            setError(
              cause instanceof Error
                ? cause.message
                : `${networkProfile.name} packet failed.`,
            );
            stopRecorder();
          })
          .finally(() => {
            queuedMediaChunksRef.current = Math.max(
              0,
              queuedMediaChunksRef.current - 1,
            );
            diagnostics.record(
              "queue-leave",
              { chunkId, depth: queuedMediaChunksRef.current },
              diagnosticsToken,
            );
            if (
              wantsVideo &&
              queuedMediaChunksRef.current <= 1 &&
              recorder.state === "paused" &&
              !stopRequestedRef.current
            ) {
              recorder.resume();
              diagnostics.record(
                "recorder-resume",
                {
                  depth: queuedMediaChunksRef.current,
                  reason: "queue-recovered",
                },
                diagnosticsToken,
              );
            }
          });
        if (
          wantsVideo &&
          queuedMediaChunksRef.current >= VIDEO_QUEUE_PAUSE_DEPTH &&
          recorder.state === "recording" &&
          !stopRequestedRef.current
        ) {
          recorder.pause();
          diagnostics.record(
            "recorder-pause",
            {
              depth: queuedMediaChunksRef.current,
              reason: "queue-pressure",
            },
            diagnosticsToken,
          );
        }
        if (
          wantsVideo &&
          queuedMediaChunksRef.current > VIDEO_QUEUE_ABORT_DEPTH
        ) {
          diagnostics.record(
            "media-drop",
            {
              chunkId,
              bytes: event.data.size,
              depth: queuedMediaChunksRef.current,
              reason: "bounded-queue-overflow",
            },
            diagnosticsToken,
          );
          setError(
            `The bounded video queue overflowed while ${networkProfile.name} was catching up. Stopping safely.`,
          );
          stopRecorder();
          return;
        }
      });
      recorder.addEventListener("stop", () => {
        // A failed start never entered the transport lifecycle.
        if (audioInput && !captureStarted) return;
        detachAudioEnded?.();
        audioInput?.captureReleased();
        diagnostics.record(
          "recorder-stop",
          { status: "media-capture-ended" },
          diagnosticsToken,
        );
        if (sessionRef.current) {
          sessionRef.current.recordingEndedAtMs ??= Date.now();
        }
        mediaStream.getTracks().forEach((track) => track.stop());
        void processingRef.current.finally(() => void finishSession());
      });
      recorderRef.current = recorder;
      streamRef.current = mediaStream;
      if (audioInput) {
        if (!hasLiveAudio(mediaStream))
          throw new DOMException(
            "Audio track ended before Start",
            "NotReadableError",
          );
        // Both calls are synchronous; no chunk task can run between them.
        // A recorder.start exception must retain the funded, prepared session.
        recorder.start(preparedSession.packetDurationMs);
        if (preparedSession.transportMode === "single-nonce-retirement-v1")
          preparedSession.transport.start();
        captureStarted = true;
        detachAudioEnded = stopOnAudioEnded(mediaStream, stopRecorder);
      } else {
        if (preparedSession.transportMode === "single-nonce-retirement-v1")
          preparedSession.transport.start();
        recorder.start(preparedSession.packetDurationMs);
      }
      sessionRef.current.startedAtMs = Date.now();
      diagnostics.record(
        "recorder-start",
        { codec: requiredMediaType },
        diagnosticsToken,
      );
      setPhase("live");
      timerRef.current = setInterval(() => {
        setSeconds((current) => current + 1);
      }, 1_000);
    } catch (cause) {
      if (audioInput && acquiredAudio && !captureStarted) {
        detachAudioEnded?.();
        if (recorderRef.current?.state !== "inactive")
          recorderRef.current?.stop();
        acquiredAudio.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        streamRef.current = null;
        audioInput.captureReleased();
      }
      diagnostics.record(
        "error",
        { errorClass: "capture-start", reason: "capture-failed" },
        diagnosticsTokenRef.current,
      );
      const presented = audioInput
        ? { message: microphoneError(cause), details: null }
        : presentWalletError(cause, "Microphone failed.");
      setError(presented.message);
      setErrorDetails(presented.details);
    } finally {
      privateStartBusyRef.current = false;
    }
  };

  const resetSession = (): void => {
    if (
      phase !== "ended" ||
      (sessionRef.current?.transportMode === "classic-v2" &&
        sessionRef.current.classic?.held)
    )
      return;
    classicAudioRef.current?.turnOff();
    setClassicResult(null);
    sessionRef.current = null;
    webmInitializationRef.current = null;
    videoBootstrapRef.current = null;
    queuedMediaChunksRef.current = 0;
    diagnosticsTokenRef.current = diagnostics.begin(
      {
        chainId: networkProfile.chainId,
        sessionAddress: "unassigned",
        streamId: "unassigned",
      },
      { mediaMode },
    );
    setLinkCopied(false);
    cleanupStartedRef.current = false;
    setPacketCount(0);
    setSeconds(0);
    setPlannedDurationSeconds(null);
    setListenerUrl(null);
    setTraceSession(null);
    setExecutionProof(EMPTY_EXECUTION_PROOF);
    const emptyLineage = createPatioReplacementLineage();
    lineageRef.current = emptyLineage;
    setReplacementLineage(emptyLineage);
    setTraceAction("verify");
    setPreparationStage(null);
    setSidePanel(null);
    setError(null);
    setErrorDetails(null);
    setPhase(operator ? "connected" : "disconnected");
  };

  const privateSummary =
    sessionRef.current?.transportMode === "single-nonce-retirement-v1" &&
    mediaMode === "audio"
      ? retirementPresentation(sessionRef.current.transport.snapshot())
      : null;
  const status =
    privateSummary && phase !== "live"
      ? privateSummary.message
      : phase === "live"
        ? privatePrepared
          ? "Live on isolated private fixture"
          : `Live on ${networkProfile.name}`
        : phase === "cleaning"
          ? "Ending broadcast…"
          : phase === "preparing"
            ? "Preparing"
            : phase === "funding"
              ? "Wallet approval"
              : phase === "held"
                ? "Needs attention — keep this tab open"
                : phase === "ended"
                  ? "Broadcast ended"
                  : phase === "ready"
                    ? "Ready"
                    : operator
                      ? "Wallet connected"
                      : "Connect wallet";
  const approving = phase === "preparing" || phase === "funding";
  return (
    <>
      <div
        className={`cast-workspace${approving && activePreparationStep ? " is-preparing" : ""}`}
        inert={approving && Boolean(activePreparationStep)}
      >
        <motion.section
          className="simple-card cast-card"
          aria-labelledby="broadcast-title"
          style={CAST_GLASS_STYLE}
          layout="size"
          transition={{
            layout: { duration: 0.36, ease: [0.22, 1, 0.36, 1] },
          }}
        >
          {phase === "live" ? (
            <div className="cast-live-status">
              <span className="broadcast-dot is-live" aria-hidden="true" />
              <span role="status">Live</span> ·{" "}
              <span>{formatTime(seconds)}</span>
            </div>
          ) : null}
          {phase !== "disconnected" && wallet ? (
            <div className="cast-context-row">
              {phase !== "connected" && phase !== "live" ? (
                <span className="simple-status">{status}</span>
              ) : null}
              <div
                className="cast-wallet-summary"
                aria-label="Connected wallet"
              >
                <strong>{shortAddress(wallet.address)}</strong>
                <span>
                  {balanceWei === null
                    ? "Balance…"
                    : `${formatEth(balanceWei, 4)} ${networkProfile.nativeCurrency.symbol}`}
                </span>
              </div>
            </div>
          ) : phase !== "disconnected" ? (
            <span
              className={`simple-status${phase === "live" ? " is-live" : ""}`}
            >
              {status}
            </span>
          ) : null}
          <h1 id="broadcast-title">
            {reviewPanel ? "Confirm Broadcast" : "Broadcast"}
          </h1>
          {!reviewPanel ? (
            <p className="simple-copy">
              {plannedDurationSeconds
                ? `${plannedDurationSeconds} seconds · ${mediaMode === "video" ? "Video" : "Audio"} · Keep this tab open.`
                : `Live audio and real tiny video through ${networkProfile.name}.`}
            </p>
          ) : null}

          {phase === "disconnected" || phase === "connected" ? (
            <div
              className="media-mode-selector segmented-control"
              data-selected={mediaMode}
              aria-label="Media mode"
            >
              <button
                className={mediaMode === "audio" ? "is-selected" : ""}
                type="button"
                aria-pressed={mediaMode === "audio"}
                onClick={() => selectMediaMode("audio")}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4 8.5v3M7 6v8M10 3.5v13M13 6v8M16 8.5v3" />
                </svg>
                Audio
              </button>
              <button
                className={mediaMode === "video" ? "is-selected" : ""}
                type="button"
                aria-pressed={mediaMode === "video"}
                onClick={() => selectMediaMode("video")}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2.5" y="5" width="10" height="10" rx="2" />
                  <path d="m12.5 8 4-2v8l-4-2" />
                </svg>
                Video
              </button>
            </div>
          ) : null}

          {phase === "disconnected" || phase === "connected" ? (
            <section
              className="broadcast-budget"
              aria-label="Broadcast settings"
            >
              <div className="broadcast-budget__duration">
                <div>
                  <strong>Broadcast duration</strong>
                  <span>— {mediaProfileLabel(mediaMode)}</span>
                </div>
                <output>
                  <AnimatedTime seconds={selectedDurationSeconds} />
                  <span className="broadcast-budget__duration-unit">sec</span>
                </output>
              </div>
              <RadioDurationSlider
                minimum={MIN_DURATION_SECONDS}
                maximum={maximumSelectableDuration}
                value={selectedDurationSeconds}
                onChange={setDurationTargetSeconds}
              />

              <div className="broadcast-budget__live-quote" aria-live="polite">
                <span>
                  Temporary {networkProfile.nativeCurrency.symbol} required
                </span>
                <strong>
                  {feeQuoteLoading && !liveFees ? (
                    "Reading network fees…"
                  ) : feeQuoteError ? (
                    "Fee request failed — Retry."
                  ) : quotedPlan?.requiredFundingWei ? (
                    <AnimatedCounter
                      value={Number(formatEther(quotedPlan.requiredFundingWei))}
                      decimals={7}
                      duration={0.48}
                      suffix={<>&nbsp;{networkProfile.nativeCurrency.symbol}</>}
                    />
                  ) : liveFees ? (
                    "Requested duration exceeds the budget."
                  ) : (
                    "Reading network fees…"
                  )}
                </strong>
              </div>

              <p role="status" hidden={!feeQuoteError}>
                {feeQuoteError
                  ? `${liveFees ? `Last estimate is stale (${Math.max(0, Math.floor((feeRead.checkedAt - liveFees.updatedAtMs) / 1000))} s old). ` : ""}${feeQuoteError}`
                  : null}
              </p>
              {feeQuoteError ? (
                <button type="button" onClick={() => void feeRead.refresh()}>
                  Retry fees
                </button>
              ) : null}
              <button
                className="fee-plan-trigger"
                type="button"
                aria-expanded={sidePanel === "fee"}
                aria-controls="fee-plan-panel"
                onClick={() =>
                  setSidePanel((current) => (current === "fee" ? null : "fee"))
                }
              >
                <span>Fee plan</span>
                <span aria-hidden="true">
                  {sidePanel === "fee" ? "Close" : "View"} →
                </span>
              </button>
            </section>
          ) : null}

          {mediaMode === "video" &&
          ["ready", "live", "cleaning"].includes(phase) ? (
            <video
              ref={videoPreviewRef}
              className={`patio-video-preview${phase === "live" ? " is-live" : ""}`}
              muted
              playsInline
              aria-label="Patio video camera preview"
            />
          ) : null}

          {phase === "live" ? (
            <LiveAudioMeter stream={streamRef.current} />
          ) : null}

          {reviewPanel}
          <div className="cast-device-row">
            {phase === "connected" ? (
              <div
                className="broadcast-mode broadcast-visibility segmented-control"
                data-selected={visibility}
                aria-label="Broadcast visibility"
              >
                <button
                  className={visibility === "public" ? "is-selected" : ""}
                  type="button"
                  aria-pressed={visibility === "public"}
                  disabled={!registryAddress}
                  title={
                    registryAddress
                      ? "Show this broadcast on Listen"
                      : "Public listing unavailable"
                  }
                  onClick={() => setVisibility("public")}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="10" cy="10" r="7" />
                    <path d="M3 10h14M10 3c4 4 4 10 0 14M10 3c-4 4-4 10 0 14" />
                  </svg>
                  Public
                </button>
                <button
                  className={visibility === "unlisted" ? "is-selected" : ""}
                  type="button"
                  aria-pressed={visibility === "unlisted"}
                  onClick={() => {
                    setVisibility("unlisted");
                    setSetupMode("classic");
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m8 12 4-4M7 13l-1 1a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M13 7l1-1a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0" />
                  </svg>
                  Unlisted
                </button>
              </div>
            ) : null}
            {!privatePrepared &&
            mediaMode === "audio" &&
            ["connected", "ready", "held"].includes(phase) ? (
              <section
                className="microphone-control"
                aria-label="Audio preparation"
              >
                <button
                  ref={microphoneButtonRef}
                  type="button"
                  className={`microphone-toggle${classicMicrophone.status === "ready" ? " is-on" : ""}${microphoneAttention ? " needs-attention" : ""}`}
                  aria-label={
                    classicMicrophone.pending
                      ? "Cancel microphone check"
                      : classicMicrophone.status === "ready"
                        ? "Turn microphone off"
                        : "Check microphone"
                  }
                  title={
                    classicMicrophone.pending
                      ? "Cancel microphone check"
                      : classicMicrophone.status === "ready"
                        ? "Turn microphone off"
                        : "Check microphone"
                  }
                  aria-pressed={classicMicrophone.status === "ready"}
                  aria-busy={classicMicrophone.pending}
                  style={
                    {
                      "--mic-level": classicMicrophone.muted
                        ? 0
                        : Math.min(1, classicMicrophone.level * 5),
                    } as CSSProperties
                  }
                  disabled={classicMicrophone.status === "transferred"}
                  onAnimationEnd={() => setMicrophoneAttention(false)}
                  onClick={() => {
                    setMicrophoneAttention(false);
                    if (
                      classicMicrophone.pending ||
                      classicMicrophone.status === "ready"
                    )
                      classicAudioRef.current?.turnOff();
                    else void classicAudioRef.current?.check();
                  }}
                >
                  <svg viewBox="0 0 32 32" aria-hidden="true">
                    <rect x="12" y="5" width="8" height="14" rx="4" />
                    <path d="M8 14v2a8 8 0 0 0 16 0v-2M16 24v4M12 28h8" />
                    <g className="microphone-pulses">
                      <path d="M4 11v9M28 11v9M1 13v5M31 13v5" />
                    </g>
                    {classicMicrophone.status !== "ready" && (
                      <path d="m6 5 20 22" />
                    )}
                  </svg>
                </button>
                <span className="visually-hidden" role="status">
                  {microphoneAttention
                    ? "Turn on your microphone to prepare."
                    : classicMicrophone.message}
                </span>
                {["unavailable", "interrupted"].includes(
                  classicMicrophone.status,
                ) ? (
                  <p className="simple-error" role="alert">
                    {classicMicrophone.message}
                  </p>
                ) : null}
              </section>
            ) : null}
            {mediaMode === "video" && phase === "connected" ? (
              <section
                className="microphone-control"
                aria-label="Video preparation"
              >
                <button
                  type="button"
                  ref={cameraButtonRef}
                  className={`microphone-toggle${cameraCheck === "ready" ? " is-on" : ""}${microphoneAttention ? " needs-attention" : ""}`}
                  aria-label="Check camera and microphone"
                  title="Check camera and microphone"
                  aria-busy={cameraCheck === "checking"}
                  disabled={cameraCheck === "checking"}
                  onAnimationEnd={() => setMicrophoneAttention(false)}
                  onClick={() => {
                    if (cameraCheckBusy.current) return;
                    setMicrophoneAttention(false);
                    cameraCheckBusy.current = true;
                    setCameraCheck("checking");
                    void (async () => {
                      try {
                        const profile = selectVideoProfile();
                        if (!profile)
                          throw new Error(
                            "This browser cannot encode Patio WebM video.",
                          );
                        await verifyMediaCapture(true, profile.mimeType);
                        setCameraCheck("ready");
                      } catch (cause) {
                        setCameraCheck("unchecked");
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Unable to access camera and microphone.",
                        );
                      } finally {
                        cameraCheckBusy.current = false;
                      }
                    })();
                  }}
                >
                  <svg viewBox="0 0 32 32" aria-hidden="true">
                    <rect x="4" y="9" width="16" height="15" rx="3" />
                    <path d="m20 14 8-4v14l-8-4" />
                  </svg>
                </button>
                {cameraCheck === "ready" ? (
                  <span className="visually-hidden" role="status">
                    Camera and microphone checked.
                  </span>
                ) : null}
              </section>
            ) : null}
          </div>
          {classicResult ? (
            <details className="simple-meta">
              <summary>Broadcast details</summary>
              <p>{classicResult}</p>
            </details>
          ) : null}
          {controlledTest &&
          sessionRef.current?.transportMode === "classic-v2" &&
          !sessionRef.current.startedAtMs ? (
            <details
              className="simple-meta"
              aria-label="Pre-broadcast cancellation"
            >
              <summary>Cancel broadcast</summary>
              <details>
                <summary>Additional deposits</summary>
                <label>
                  Additional confirmed funding hashes (only if another transfer
                  actually occurred)
                  <input
                    value={extraFundingHashes}
                    onChange={(e) => setExtraFundingHashes(e.target.value)}
                    disabled={cancelBusy}
                  />
                </label>
              </details>
              <button
                type="button"
                disabled={cancelBusy || privateStartBusyRef.current}
                onClick={() =>
                  void (async () => {
                    if (cancelBusyRef.current || privateStartBusyRef.current)
                      return;
                    const session = sessionRef.current;
                    if (
                      session?.transportMode !== "classic-v2" ||
                      !session.classic
                    )
                      return;
                    cancelBusyRef.current = true;
                    setCancelBusy(true);
                    setError(null);
                    try {
                      const hashes = [
                        session.fundingHash,
                        ...extraFundingHashes.split(/[\s,]+/),
                      ].filter(Boolean) as Hex[];
                      if (hashes.some((h) => !/^0x[0-9a-fA-F]{64}$/.test(h)))
                        throw new Error(
                          "Use exact funding hashes, not amounts or keys",
                        );
                      setCancelReview(
                        await session.classic.reviewCancellation(hashes),
                      );
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Cancellation review unavailable",
                      );
                    } finally {
                      cancelBusyRef.current = false;
                      setCancelBusy(false);
                    }
                  })()
                }
              >
                Review cancellation
              </button>
              {cancelReview ? (
                <p>
                  Return at least {formatEther(cancelReview.value)} ETH to{" "}
                  {operator}. Maximum gas{" "}
                  {formatEther(cancelReview.maximumGasCost)} ETH. Residual may
                  remain.
                </p>
              ) : null}
              {cancelReview ? (
                <button
                  type="button"
                  disabled={cancelBusy}
                  onClick={() =>
                    void (async () => {
                      if (cancelBusyRef.current || privateStartBusyRef.current)
                        return;
                      const session = sessionRef.current;
                      if (
                        session?.transportMode !== "classic-v2" ||
                        !session.classic
                      )
                        return;
                      cancelBusyRef.current = true;
                      setCancelBusy(true);
                      setError(null);
                      try {
                        const hash =
                          await session.classic.cancelBeforeMedia(cancelReview);
                        setCancelReview(null);
                        setPhase("held");
                        setClassicResult(
                          `Cancellation submitted ${hash}. Return not yet confirmed; keep this tab open.`,
                        );
                      } catch (cause) {
                        setPhase("held");
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Cancellation held; no automatic retry",
                        );
                      } finally {
                        setCancelBusy(false);
                      }
                    })()
                  }
                >
                  Approve this cancellation
                </button>
              ) : null}
              {sessionRef.current.classic?.cancellationClaimed ? (
                <button
                  type="button"
                  onClick={() =>
                    void (async () => {
                      const session = sessionRef.current;
                      if (
                        session?.transportMode !== "classic-v2" ||
                        !session.classic
                      )
                        return;
                      try {
                        if (await session.classic.confirmCancellation()) {
                          setPhase("ended");
                          setClassicResult(
                            `Cancellation included. Returned ${formatEther(session.classic.returned!)} ETH; residual ${formatEther(session.classic.residual!)} ETH. Finality not asserted.`,
                          );
                        } else
                          setClassicResult(
                            "Cancellation pending or unknown; keep this tab open. No resend.",
                          );
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Cancellation evidence unavailable",
                        );
                      }
                    })()
                  }
                >
                  Check cancellation (read-only)
                </button>
              ) : null}
            </details>
          ) : null}

          {phase === "disconnected" ? (
            <button
              className="primary-action connect-wallet-action"
              type="button"
              disabled={connecting || sessionLocked}
              onClick={connectWallet}
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          ) : phase === "connected" ? (
            <>
              <div className="cast-prepare-actions">
                {atomicSetupReview ? (
                  <button
                    className="primary-action"
                    type="button"
                    disabled={atomicSetupState !== "review"}
                    onClick={confirmAtomicSetup}
                  >
                    {atomicSetupState === "review"
                      ? "Confirm atomic setup"
                      : atomicSetupState === "awaiting-verification"
                        ? "Awaiting verification"
                        : "Atomic setup held"}
                  </button>
                ) : (
                  <button
                    className="primary-action"
                    type="button"
                    disabled={
                      !directConfigured ||
                      relayRpc.providerSelection === true ||
                      Boolean(feeQuoteError) ||
                      feeQuoteLoading ||
                      cameraCheck === "checking" ||
                      !quotedPlan ||
                      quotedPlan.feePlan.affordableDurationSeconds <
                        selectedDurationSeconds
                    }
                    onClick={prepareSession}
                  >
                    {feeQuoteLoading ? "Refreshing gas…" : "Set up broadcast"}
                  </button>
                )}
                {atomicSetupReview &&
                atomicSetupState === "awaiting-verification" ? (
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={reconcileAtomicSetup}
                  >
                    Check setup status
                  </button>
                ) : null}
              </div>
              {atomicSetupEnabled && visibility === "public" ? (
                <div
                  className="broadcast-mode segmented-control"
                  data-selected={setupMode}
                  aria-label="Public broadcast setup mode"
                >
                  <button
                    className={setupMode === "classic" ? "is-selected" : ""}
                    type="button"
                    aria-pressed={setupMode === "classic"}
                    disabled={Boolean(atomicSetupReview)}
                    onClick={() => setSetupMode("classic")}
                  >
                    Classic setup
                  </button>
                  <button
                    className={
                      setupMode === "wallet-atomic" ? "is-selected" : ""
                    }
                    type="button"
                    aria-pressed={setupMode === "wallet-atomic"}
                    disabled={Boolean(atomicSetupReview)}
                    onClick={() => setSetupMode("wallet-atomic")}
                  >
                    Atomic wallet setup — experimental
                  </button>
                </div>
              ) : null}
              {atomicSetupReview ? (
                <aside className="simple-meta" aria-live="polite">
                  <strong>Atomic wallet setup — experimental</strong>
                  <br />
                  Announce{" "}
                  {shortAddress(atomicSetupReview.announcement.registry)} then
                  fund{" "}
                  {shortAddress(atomicSetupReview.descriptor.sessionAddress)}{" "}
                  with {formatEth(atomicSetupReview.fundingAmountWei)}{" "}
                  {networkProfile.nativeCurrency.symbol}. Return reserve:{" "}
                  {formatEth(atomicSetupReview.returnPlan.cleanupReserveWei)}{" "}
                  {networkProfile.nativeCurrency.symbol}. The session EOA and
                  media transport stay unchanged.
                </aside>
              ) : null}
              <p className="broadcast-visibility-note">
                {visibility === "public"
                  ? 'Listen on "Public"'
                  : registryAddress
                    ? "Shareable link · not listed on Listen"
                    : "Unlisted · public registry setup pending"}
              </p>
            </>
          ) : phase === "ready" ? (
            <div className="live-session-actions">
              {listenerUrl ? (
                <button
                  className="secondary-action share-action"
                  type="button"
                  onClick={shareListenerLink}
                >
                  <ShareIcon />
                  {linkCopied ? "Link copied" : "Share link"}
                </button>
              ) : null}
              <button
                className="primary-action"
                type="button"
                onClick={startBroadcast}
                disabled={
                  privatePrepared
                    ? Boolean(privatePrepared.audioInput) && !privateAudioReady
                    : mediaMode === "audio" &&
                      classicMicrophone.status !== "ready"
                }
              >
                Start now
              </button>
            </div>
          ) : phase === "live" ? (
            <div className="live-session-actions">
              <button
                className="secondary-action share-action"
                type="button"
                onClick={shareListenerLink}
              >
                <ShareIcon />
                {linkCopied ? "Link copied" : "Share link"}
              </button>
              <button
                className="primary-action danger"
                type="button"
                onClick={stopRecorder}
              >
                Stop safely
              </button>
            </div>
          ) : phase === "held" ? (
            <button
              className="primary-action danger"
              type="button"
              onClick={async () => {
                const current = sessionRef.current;
                if (current?.transportMode !== "single-nonce-retirement-v1") {
                  if (!current?.classic) {
                    setError(
                      "Legacy session retained. No automatic migration or resend.",
                    );
                    return;
                  }
                  const classic = current.classic;
                  try {
                    const funding = classic.financial.find(
                      (entry) => entry.role === "funding",
                    );
                    if (
                      funding &&
                      !classic.frozen &&
                      current.startedAtMs === null
                    ) {
                      await classic.reconcileFunding();
                      setListenerUrl(current.listenerUrl);
                      setPlannedDurationSeconds(
                        Math.floor(
                          (current.totalPackets * current.packetDurationMs) /
                            1_000,
                        ),
                      );
                      setPhase("ready");
                      setError(null);
                    } else if (
                      classic.signatures.some((entry) => entry.role === "sweep")
                    ) {
                      await classic.confirmSweep();
                      saveClassicHistory(current);
                      setClassicResult(
                        `Return confirmed: ${classic.returned === null ? "Unknown" : formatEther(classic.returned)} ETH. Residual: ${classic.residual === null ? "Unknown" : formatEther(classic.residual)} ETH. Known media included: ${classic.mediaIncluded.size}; incidents are not erased.`,
                      );
                      setPhase("ended");
                    } else if (classic.frozen) {
                      await classic.reconcile();
                      setError(
                        `Classic close reconciled; ${classic.mediaIncluded.size} media included. No sweep sent by this read-only action. Keep the session open.`,
                      );
                    } else {
                      if (
                        classic.financial.some(
                          (entry) => entry.role === "registry",
                        )
                      )
                        await classic.confirmFinancial("registry");
                      setError(
                        "Preparation retained. This check does not repeat registry or funding; keep this tab open.",
                      );
                    }
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Read-only reconciliation unavailable",
                    );
                  }
                  return;
                }
                try {
                  const evidence = await current.transport.reconcile();
                  if (evidence.state === "complete") setPhase("ended");
                  else
                    setError(
                      `Retirement state: ${evidence.state}. Read-only reconciliation; no transaction sent.`,
                    );
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Read-only reconciliation unavailable.",
                  );
                }
              }}
            >
              {privatePrepared
                ? "Reconcile retirement (read only)"
                : "Reconcile session (read only)"}
            </button>
          ) : phase === "ended" && !privatePrepared ? (
            <button
              className="primary-action new-broadcast-action"
              type="button"
              onClick={resetSession}
            >
              New broadcast
            </button>
          ) : phase === "preparing" ||
            phase === "funding" ||
            (phase === "ended" && privatePrepared) ? null : (
            <button className="primary-action" type="button" disabled>
              Working…
            </button>
          )}

          {phase === "disconnected" ? (
            <p className="simple-meta">
              {networkProfile.name}
              {networkProfile.status === "experimental"
                ? " · experimental"
                : " · testnet"}
              <>
                {networkProfile.faucetUrl ? (
                  <>
                    {" · "}
                    <a
                      className="hoodi-faucet-link"
                      href={networkProfile.faucetUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Get{" "}
                      {networkProfile.id === "hoodi"
                        ? "Hoodi ETH"
                        : networkProfile.nativeCurrency.symbol}{" "}
                      ↗
                    </a>
                  </>
                ) : null}
              </>
            </p>
          ) : phase === "live" ? (
            <p className="simple-meta">
              {formatTime(seconds)} · {packetCount} packets
              {mediaMode === "video"
                ? ` · ${segmentCount} segments · ${(mediaBytes / 1_024).toFixed(1)} KiB`
                : " · audio"}
            </p>
          ) : null}
          {sessionRef.current ? (
            <p className="session-budget">
              {formatEth(sessionRef.current.fundingAmountWei, 5)}{" "}
              {privatePrepared
                ? "private fixture ETH"
                : networkProfile.id === "hoodi"
                  ? "Hoodi ETH"
                  : networkProfile.nativeCurrency.symbol}{" "}
              {sessionRef.current.transportMode === "classic-v2" &&
              sessionRef.current.classic?.financial.find(
                (entry) => entry.role === "funding",
              )?.state !== "confirmed"
                ? "· funding pending"
                : "· funded"}
            </p>
          ) : null}
          {privatePrepared && sessionRef.current && sidePanel === "proof" ? (
            <MediaDiagnosticsPanel session={diagnostics} />
          ) : null}
          {privateSummary && (
            <section aria-label="Session completion summary">
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={
                  privateSummary.needsAttention ? "simple-error" : "simple-meta"
                }
              >
                {privateSummary.message}.{" "}
                {privateSummary.needsAttention
                  ? "Keep this tab open. Do not reload or start another session; export diagnostics for review."
                  : privateSummary.complete
                    ? "Canonical close and return receipts verified. This does not say another browser finished listening, or establish finality."
                    : "Recording, retirement and balance return are separate steps."}
              </p>
              <details className="stream-transport-proof">
                <summary>Close and return details</summary>
                <dl>
                  <div>
                    <dt>Temporary funding</dt>
                    <dd>{privateSummary.funding}</dd>
                  </div>
                  <div>
                    <dt>Media retirement</dt>
                    <dd>
                      {privateSummary.closeVerified
                        ? "Canonically verified"
                        : "Not verified"}
                    </dd>
                  </div>
                  <div>
                    <dt>Close gas paid</dt>
                    <dd>{privateSummary.closeGas}</dd>
                  </div>
                  <div>
                    <dt>Return receipt</dt>
                    <dd>
                      {privateSummary.returnVerified
                        ? "Canonically included"
                        : "Not verified — a hash is not a return"}
                    </dd>
                  </div>
                  <div>
                    <dt>Return gas paid</dt>
                    <dd>{privateSummary.sweepGas}</dd>
                  </div>
                  <div>
                    <dt>Confirmed value returned</dt>
                    <dd>{privateSummary.returned}</dd>
                  </div>
                  <div>
                    <dt>Residual session balance</dt>
                    <dd>{privateSummary.residual}</dd>
                  </div>
                  <div>
                    <dt>Operator funding gas</dt>
                    <dd>{privateSummary.fundingGas}</dd>
                  </div>
                </dl>
              </details>
            </section>
          )}
          {sessionRef.current?.transportMode ===
          "single-nonce-retirement-v1" ? (
            <details>
              <summary>
                Private retirement transport · public networks closed
              </summary>
              <p>
                One media nonce. {sessionRef.current.totalPackets} candidates
                maximum. Keep this tab open; the session key cannot be recovered
                after reload.
              </p>
              <button
                type="button"
                onClick={() => {
                  const session = sessionRef.current;
                  if (session?.transportMode !== "single-nonce-retirement-v1")
                    return;
                  const url = URL.createObjectURL(
                    new Blob(
                      [JSON.stringify(session.transport.snapshot(), null, 2)],
                      { type: "application/json" },
                    ),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "patio-private-retirement.json";
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export retirement metadata
              </button>
            </details>
          ) : null}
          {!directConfigured && !privatePrepared ? (
            <p className="simple-error">
              Wallet connection is available. Broadcast transport unavailable /
              not yet enabled.
              {!relayRpc.url || relayRpc.providerSelection
                ? " Sender not configured for broadcasting."
                : ""}
              {!observerRpc.url
                ? " Observer unavailable on this deployment."
                : ""}
            </p>
          ) : null}
          {error ? (
            <div className="simple-error" role="alert">
              <strong>{error}</strong>
              {errorDetails && error.startsWith("Transaction cancelled") ? (
                <details className="wallet-error-details">
                  <summary>Technical details</summary>
                  <pre>{errorDetails}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </motion.section>
        <FeePlanPanel
          open={sidePanel === "fee" && !privatePrepared}
          onClose={() => setSidePanel(null)}
          liveFees={liveFees}
          quotedPlan={quotedPlan}
          networkCostEstimate={networkCostEstimate}
          loading={feeQuoteLoading}
          unavailableMessage={
            feeQuoteError ??
            (quotedPlan
              ? null
              : `Current fees make this duration unavailable within Patio's ${formatEther(networkProfile.safety.maximumSessionExposureWei)} ${networkProfile.nativeCurrency.symbol} limit.${
                  maximumAffordablePlan
                    ? ` Maximum available: ${formatTime(maximumAffordablePlan.feePlan.affordableDurationSeconds)}.`
                    : " No safe broadcast is currently available."
                }`)
          }
          networkProfile={networkProfile}
        />
        {privatePrepared && sidePanel !== null ? (
          <aside className="simple-meta">
            <strong>Isolated single-nonce transport — not Hoodi</strong>
            <p>
              Close / media / sweep: {privatePrepared.transport.snapshot().g} /{" "}
              {privatePrepared.transport.snapshot().m} /{" "}
              {privatePrepared.transport.snapshot().s}.
            </p>
            <p>
              State: {privatePrepared.transport.snapshot().state}. Capacity:{" "}
              {privatePrepared.transport.plan.candidates}. Exposure:{" "}
              {formatEth(privatePrepared.transport.plan.requiredExposure)}{" "}
              private ETH.
            </p>
            <p>
              Close reserve:{" "}
              {formatEth(privatePrepared.transport.plan.closeReserve)}. Sweep
              reserve: {formatEth(privatePrepared.transport.plan.sweepReserve)}.
              No seals or ordinary release.
            </p>
            <button type="button" onClick={() => setSidePanel(null)}>
              Close private proof
            </button>
          </aside>
        ) : !privatePrepared && sidePanel !== "fee" ? (
          <EthereumExecutionPanel
            open={sidePanel === "proof"}
            onOpenChange={(open) => setSidePanel(open ? "proof" : null)}
            phase={phase}
            action={traceAction}
            session={traceSession}
            packetCount={packetCount}
            proof={executionProof}
            replacementLineage={replacementLineage}
            networkProfile={networkProfile}
          >
            {reviewDetails}
            {sessionRef.current ? (
              <MediaDiagnosticsPanel session={diagnostics} />
            ) : null}
          </EthereumExecutionPanel>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {approving && activePreparationStep ? (
          <motion.div
            className="cast-preparation-backdrop"
            role="presentation"
            style={CAST_BACKDROP_STYLE}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24 }}
          >
            <motion.section
              className="cast-preparation"
              role="dialog"
              aria-modal="true"
              aria-label="Broadcast preparation progress"
              aria-live="polite"
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              style={PREPARATION_GLASS_STYLE}
            >
              <span className="cast-preparation__step">
                Step {preparationStepIndex + 1} of{" "}
                {activePreparationSteps.length}
              </span>
              <h2>Preparing {mediaMode === "video" ? "video" : "audio"}</h2>
              <strong>{activePreparationStep.label}</strong>
              <progress
                max={activePreparationSteps.length}
                value={preparationStepIndex + 1}
                aria-label="Broadcast preparation"
              />
              <p>{activePreparationStep.description}</p>
            </motion.section>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <LiveReactions
        streamId={traceSession?.streamId ?? null}
        active={phase === "live"}
        canReact={false}
      />
    </>
  );
}

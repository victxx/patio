"use client";

/** Private host: mounted only in the isolated H2.6/D1 build, never a public route. */
import { useEffect, useRef, useState } from "react";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { DirectCastConsole } from "../../components/direct-cast-console";
import { DirectTuneConsole } from "../../components/direct-tune-console";
import {
  AudioPreflight,
  initialMicrophoneState,
} from "../../lib/audio-preflight";
import {
  PrivateAudioPreparation,
  audioPlanKey,
  type AudioReview,
} from "../../lib/private-audio-preparation";
import {
  PrivateRetirementEnvironment,
  type PrivateFixtureManifest,
  type PrivateRetirementRpc,
} from "../../lib/private-retirement-environment";
import { SingleNonceTransport } from "../../lib/single-nonce-transport";
import {
  quoteSingleNonce,
  RETIREMENT_DEFAULT_BUDGET,
  RETIREMENT_HARD_CEILING,
} from "../../lib/single-nonce-plan";
import type { DirectSessionDescriptor } from "../../lib/direct-hoodi";

const bridge =
  process.env.NEXT_PUBLIC_PATIO_PRIVATE_BRIDGE ?? "http://127.0.0.1:18780";
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${bridge}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Private fixture ${path}: ${response.status}. Session retained; no automatic retry.`,
    );
  return response.json() as Promise<T>;
}
async function environment() {
  const config = await request<{
    manifest: PrivateFixtureManifest;
    operator: Address;
    fundingFeeCapWei?: string;
  }>("/manifest");
  const endpoints = [0, 1, 2].map((i): PrivateRetirementRpc => ({
    request: <T,>(method: string, params: readonly unknown[] = []) =>
      request<T>(`/rpc/${i}`, { method, params }),
  })) as [PrivateRetirementRpc, PrivateRetirementRpc, PrivateRetirementRpc];
  return {
    env: await PrivateRetirementEnvironment.attest(config.manifest, endpoints),
    operator: config.operator,
    fundingFeeCapWei: config.fundingFeeCapWei,
  };
}
type Context = Awaited<ReturnType<typeof environment>>;
type Health = {
  ready: boolean;
  reason?: string;
  prepared: boolean;
  fundingAttempted: boolean;
};

export default function FullAppHost() {
  const [listener, setListener] = useState(false);
  const [health, setHealth] = useState<Health>();
  const [microphone, setMicrophone] = useState(initialMicrophoneState);
  const [budget, setBudget] = useState(formatEther(RETIREMENT_DEFAULT_BUDGET));
  const [working, setWorking] = useState(false);
  const [, refresh] = useState(0);
  const [message, setMessage] = useState(
    "Check your microphone, then review the private plan. No wallet connection.",
  );
  const [prepared, setPrepared] = useState<{
    transport: SingleNonceTransport;
    mediaMode: "audio";
    audioInput: AudioPreflight;
    listenerUrl: string;
  }>();
  const [tune, setTune] = useState<{
    environment: PrivateRetirementEnvironment;
    descriptor: DirectSessionDescriptor;
  }>();
  const micRef = useRef<AudioPreflight | null>(null);
  const coordinator = useRef<PrivateAudioPreparation<
    Context,
    SingleNonceTransport
  > | null>(null);
  const mounted = useRef(false);
  const actionBusy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setListener(location.pathname.endsWith("/listen"));
    const mic = new AudioPreflight(setMicrophone);
    micRef.current = mic;
    const read = async (
      selectedBudget: bigint,
    ): Promise<AudioReview<Context>> => {
      if (selectedBudget <= 0n || selectedBudget > RETIREMENT_HARD_CEILING)
        throw new Error(
          "Choose an exposure limit above zero and at or below 0.005 private ETH.",
        );
      const status = await request<Health>("/health");
      if (!status.ready)
        throw new Error(status.reason ?? "Private topology blocked");
      if (status.prepared || status.fundingAttempted)
        throw new Error(
          "This launcher already owns a session. Keep its original tab; no new funding.",
        );
      const context = await environment();
      const [block, tip] = await Promise.all([
        context.env.close.request<{ baseFeePerGas: Hex }>(
          "eth_getBlockByNumber",
          ["latest", false],
        ),
        context.env.close.request<Hex>("eth_maxPriorityFeePerGas"),
      ]);
      return Object.freeze({
        context,
        plan: quoteSingleNonce({
          baseFee: BigInt(block.baseFeePerGas),
          priorityFee: BigInt(tip),
          candidates: 4,
          budget: selectedBudget,
        }),
        binding: JSON.stringify([context.env.manifest, context.operator]),
        observedAt: performance.now(),
      });
    };
    const preparation = new PrivateAudioPreparation({
      read,
      microphone: () => {
        mic.assertReady();
      },
      now: () => performance.now(),
      create: (review: AudioReview<Context>) =>
        SingleNonceTransport.prepare(review.context.env, {
          operator: review.context.operator,
          candidates: review.plan.candidates,
          budget: review.plan.budget,
          onEvent: (event) => {
            // Reuse controller events for the compact close summary; no watcher.
            if (mounted.current && event.role !== "media")
              refresh((value) => value + 1);
            void request("/event", event).catch(() => undefined);
          },
        }),
      plan: (session: SingleNonceTransport) => session.plan,
      register: async (session, review) => {
        await request("/review", {
          budget: String(review.plan.budget),
          planKey: audioPlanKey(review.plan),
        });
        mic.assertReady();
        await request("/prepared", session.snapshot());
      },
      fund: (session, beforeRequest) =>
        session.fund((address, value) => {
          beforeRequest();
          return request<void>("/fund", { address, value: String(value) });
        }),
      confirm: (session) => session.confirmFunding(),
    });
    coordinator.current = preparation;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await request<Health>("/health");
        if (!stopped) setHealth(value);
      } catch {
        if (!stopped)
          setHealth({
            ready: false,
            reason: "Private environment unavailable",
            prepared: false,
            fundingAttempted: false,
          });
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      mounted.current = false;
      stopped = true;
      clearTimeout(timer);
      preparation.dispose();
      mic.dispose();
    };
  }, []);
  const controller = coordinator.current;
  const review = controller?.review;
  const retained = Boolean(controller?.session);
  const anotherSession =
    !retained && Boolean(health?.prepared || health?.fundingAttempted);
  const locked = working || retained || anotherSession;
  const readyMic = microphone.status === "ready" && !microphone.pending;
  const update = () => refresh((value) => value + 1);
  async function run(action: () => Promise<void>) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setWorking(true);
    try {
      await action();
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "Private preparation unavailable; keep this tab open.",
        );
    } finally {
      actionBusy.current = false;
      if (mounted.current) {
        setWorking(false);
        update();
      }
    }
  }
  function showPrepared(transport: SingleNonceTransport) {
    if (!mounted.current || !micRef.current) return;
    setPrepared({
      transport,
      mediaMode: "audio",
      audioInput: micRef.current,
      listenerUrl: `${location.origin}/h26/listen`,
    });
    setMessage(
      "Prepared — not broadcasting. Open the listener, then press Start when ready. Keep this tab open.",
    );
  }
  async function listen() {
    const { env } = await environment();
    const descriptor = await request<DirectSessionDescriptor>("/descriptor");
    setTune({ environment: env, descriptor });
    setMessage("Independent observer C — real pending transactions");
  }
  const state = prepared?.transport.snapshot().state;
  return (
    <main className="simple-page">
      <h1>Patio audio demo</h1>
      <p>Local private demo · not Hoodi · test funds</p>
      <p role="status">
        {!health
          ? "Preparing environment…"
          : health.ready
            ? "Environment ready · waiting for your actions"
            : `Blocked: ${health.reason}`}
      </p>
      <p role="status">
        {state && state !== "prepared"
          ? `Session retained — ${state}. See broadcast status below.`
          : message}
      </p>
      {listener ? (
        <>
          <button disabled={!health?.ready} onClick={() => void run(listen)}>
            Attach independent listener
          </button>
          {tune && (
            <DirectTuneConsole
              networkConfigs={[]}
              stationFrequency="1337"
              privateFixture={tune}
            />
          )}
        </>
      ) : (
        <>
          <section
            className="broadcast-budget"
            aria-label="Private audio preparation"
          >
            <h2>Microphone</h2>
            <p role="status">
              {microphone.message}
              {microphone.muted
                ? " · Track temporarily muted; no automatic stop."
                : ""}
            </p>
            <div className="live-session-actions">
              <button
                className="secondary-action"
                disabled={
                  microphone.pending ||
                  microphone.status === "ready" ||
                  microphone.status === "transferred" ||
                  working
                }
                onClick={() => void micRef.current?.check()}
              >
                Check microphone
              </button>
              <button
                className="secondary-action"
                disabled={
                  microphone.status === "transferred" ||
                  (!microphone.pending && microphone.status !== "ready")
                }
                onClick={() => micRef.current?.turnOff()}
              >
                {microphone.pending
                  ? "Cancel local wait"
                  : "Turn microphone off"}
              </button>
            </div>
            {microphone.status === "ready" && (
              <>
                <label>
                  Input level{" "}
                  <meter
                    aria-label="Microphone input level"
                    min={0}
                    max={1}
                    value={microphone.level}
                  />
                </label>
                <p>
                  Microphone active locally. Nothing is recorded or transmitted
                  until Start.
                </p>
                <p>
                  {microphone.meter === "active"
                    ? "Silence is normal; no minimum level is required."
                    : `Level meter ${microphone.meter}. A live microphone remains valid.`}
                </p>
              </>
            )}
            <h2>Review plan</h2>
            <label>
              Temporary exposure limit (private ETH){" "}
              <input
                aria-label="Temporary exposure limit (private ETH)"
                type="text"
                inputMode="decimal"
                value={budget}
                disabled={locked}
                onChange={(event) => {
                  if (coordinator.current?.invalidate()) {
                    setBudget(event.target.value);
                    update();
                  }
                }}
              />
            </label>
            <button
              className="secondary-action"
              disabled={!health?.ready || locked}
              onClick={() =>
                void run(async () => {
                  await coordinator.current!.read(parseEther(budget));
                  setMessage(
                    "Review the current plan. Reserves are not money already spent.",
                  );
                })
              }
            >
              Review plan
            </button>
            {review && (
              <>
                <dl className="broadcast-budget__summary">
                  <div>
                    <dt>Selected exposure limit</dt>
                    <dd>{formatEther(review.plan.budget)} private ETH</dd>
                  </div>
                  <div>
                    <dt>Temporary session funding</dt>
                    <dd>
                      {formatEther(review.plan.requiredExposure)} private ETH
                    </dd>
                  </div>
                  <div>
                    <dt>Maximum candidates</dt>
                    <dd>{review.plan.candidates}</dd>
                  </div>
                  <div>
                    <dt>Nominal audio duration</dt>
                    <dd>
                      About {review.plan.estimatedDurationSeconds} seconds, not
                      guaranteed
                    </dd>
                  </div>
                  <div>
                    <dt>Maximum close reserve</dt>
                    <dd>{formatEther(review.plan.closeReserve)} private ETH</dd>
                  </div>
                  <div>
                    <dt>Maximum return reserve</dt>
                    <dd>{formatEther(review.plan.sweepReserve)} private ETH</dd>
                  </div>
                  <div>
                    <dt>Included safety margin</dt>
                    <dd>{formatEther(review.plan.safetyMargin)} private ETH</dd>
                  </div>
                  <div>
                    <dt>Separate fixture-operator funding fee cap</dt>
                    <dd>
                      {review.context.fundingFeeCapWei
                        ? `${formatEther(BigInt(review.context.fundingFeeCapWei))} private ETH`
                        : "Unknown"}
                    </dd>
                  </div>
                  <div>
                    <dt>Actual cost / amount returned</dt>
                    <dd>
                      Unknown until execution; full return is not promised
                    </dd>
                  </div>
                </dl>
                {!review.plan.allowed && (
                  <p role="status">
                    Budget insufficient for this plan. Minimum calculated
                    funding: {formatEther(review.plan.requiredExposure)} private
                    ETH. Edit the limit explicitly and review again; maximum
                    0.005.
                  </p>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(controller?.approved)}
                    disabled={!review.plan.allowed || locked}
                    onChange={(event) => {
                      coordinator.current?.approve(event.target.checked);
                      update();
                    }}
                  />{" "}
                  I reviewed this private plan and its temporary funding.
                </label>
              </>
            )}
            <button
              className="primary-action"
              disabled={
                !health?.ready || !readyMic || !controller?.approved || locked
              }
              onClick={() =>
                void run(async () =>
                  showPrepared(await coordinator.current!.prepare()),
                )
              }
            >
              Prepare session
            </button>
            {!retained && (
              <p>
                {anotherSession
                  ? "A session already exists in this launcher. Use its original tab; reloading cannot recover its key."
                  : "Preparation needs a live checked microphone, an affordable reviewed plan and the verified private topology. Prepare does not start recording."}
              </p>
            )}
            {controller?.phase === "funding-uncertain" && (
              <>
                <p role="status">
                  Funding outcome uncertain. This session and its key are
                  retained. Do not prepare again or reload.
                </p>
                <button
                  disabled={working}
                  onClick={() =>
                    void run(async () =>
                      showPrepared(await coordinator.current!.reconcile()),
                    )
                  }
                >
                  Reconcile funding (read only)
                </button>
              </>
            )}
            {controller?.phase === "held" && (
              <p role="status">
                Unfunded preparation held. Session retained; no automatic
                funding retry or replacement.
              </p>
            )}
          </section>
          <button
            disabled={!retained || working}
            onClick={() =>
              void run(async () => {
                await request(
                  "/snapshot",
                  coordinator.current!.session!.snapshot(),
                );
                setMessage("Private session proof saved.");
              })
            }
          >
            Save private session proof
          </button>
          {prepared && (
            <>
              <a href={prepared.listenerUrl} target="_blank" rel="noreferrer">
                Open this session’s listener
              </a>
              {!readyMic &&
                microphone.status !== "transferred" &&
                state === "prepared" && (
                  <p>
                    Session funded and retained. Check the microphone again to
                    enable Start.
                  </p>
                )}
              <DirectCastConsole
                networkConfigs={[]}
                privatePrepared={prepared}
                privateAudioReady={readyMic}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}

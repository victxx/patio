/** D3 explicit browser check. Real synthetic Opus/WebM + MediaSource/timeline.
 * ALL listener RPC is intercepted. No funded session, microphone, wallet or P2P.
 * Never invoked by demo:radio. Export only counters/diagnostic metadata.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  encodePatioPacket,
  PatioCodec,
  PatioPacketType,
} from "../packages/protocol/src/index";
import {
  makeWebmChunkSeekable,
  frameWebmAudioPayload,
} from "../apps/web/lib/webm";
import {
  recordAudioFixture,
  h1ArrivalScheduleMs,
} from "../apps/web/test-fixtures/audio-listener-media";

const station = `0x${"1".repeat(40)}`;
const streamId = `0x${"1".repeat(32)}` as const;
const instrumentation = `(() => {
  const state = window.__d3 = { mode: 'normal', reject: null, counts: { capture: 0, wallet: 0, play: 0, sources: 0, mediaSources: 0 } };
  navigator.mediaDevices.getUserMedia = () => { state.counts.capture++; return Promise.reject(new Error('capture forbidden')); };
  Object.defineProperty(window, 'ethereum', { value: { request() { state.counts.wallet++; return Promise.reject(new Error('wallet forbidden')); } } });
  const MS = window.MediaSource;
  window.MediaSource = class extends MS { constructor() { super(); state.counts.mediaSources++; } };
  const source = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function(...args) { state.counts.sources++; return source.apply(this,args); };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    state.counts.play++;
    if (state.mode === 'blocked') return Promise.reject(new DOMException('simulated policy denial','NotAllowedError'));
    if (state.mode === 'pending') return new Promise((_, reject) => { state.reject = reject; });
    return play.call(this);
  };
})();`;
type Model = {
  available: number;
  retired: boolean;
  pendingClose: boolean;
  failRpc: boolean;
  started: number;
  schedule: boolean;
  reads: number;
  forbidden: string[];
};
type Summary = Record<string, number | string | boolean | null>;

async function main() {
  const directory = process.argv[2];
  assert(typeof directory === "string" && directory.startsWith("/"));
  const config = JSON.parse(
    readFileSync(join(directory, "launcher.json"), "utf8"),
  ) as { app: string; bridge: string };
  for (const origin of [config.app, config.bridge])
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  const results: { case: string; evidence: unknown }[] = [];
  const generator = await browser.newPage();
  await generator.goto(`${config.app}/h26/listen`);
  await generator.getByRole("heading", { name: "Patio audio demo" }).click();
  // Same real generator and arrival schedule as the existing H1/H2 regression.
  const recording = await generator.evaluate(recordAudioFixture);
  await generator.close();
  let initialization: Uint8Array | null = null;
  const inputs = recording.chunks.map((chunk, sequence) => {
    const seekable = makeWebmChunkSeekable(
      Uint8Array.from(chunk),
      initialization,
    );
    initialization = seekable.initializationSegment;
    return `0x${Buffer.from(
      encodePatioPacket({
        version: 1,
        type: seekable.resyncable
          ? PatioPacketType.START
          : PatioPacketType.AUDIO,
        codec: PatioCodec.OPUS_WEBM,
        flags: 0,
        streamId,
        windowIndex: 0,
        sequence,
        capturedAtMs: 1n,
        payload: frameWebmAudioPayload(
          seekable.payload,
          seekable.resyncable ? (initialization?.length ?? 0) : 0,
        ),
      }),
    ).toString("hex")}`;
  });
  assert.equal(inputs.length, 20);

  async function mock(context: BrowserContext, model: Model) {
    const ids = ["a".repeat(128), "b".repeat(128), "c".repeat(128)];
    const genesisHash = `0x${"1".repeat(64)}`;
    await context.route(`${config.bridge}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      let value: unknown;
      if (path === "/health")
        value = { ready: true, prepared: true, fundingAttempted: false };
      else if (path === "/manifest")
        value = {
          manifest: {
            kind: "patio-owned-prague-fixture",
            chainId: 1337,
            genesisHash,
            nodeIds: ids,
          },
          operator: station,
        };
      else if (path === "/descriptor")
        value = {
          version: 1,
          transportMode: "single-nonce-retirement-v1",
          chainId: 1337,
          operator: station,
          sessionAddress: station,
          streamId,
          nonceStart: "0",
        };
      else if (path.startsWith("/rpc/")) {
        model.reads++;
        const node = Number(path.at(-1));
        const { method, params } = route.request().postDataJSON() as {
          method: string;
          params: string[];
        };
        if (method === "eth_chainId") value = "0x539";
        else if (method === "web3_clientVersion")
          value =
            node === 0
              ? "Nethermind/v1.39.3+28cbe2a0"
              : "Geth/v1.17.5-9621c6ad";
        else if (method === "admin_nodeInfo") value = { id: ids[node] };
        else if (method === "admin_peers")
          value = ids.filter((_, i) => i !== node).map((id) => ({ id }));
        else if (method === "eth_syncing") value = false;
        else if (method === "eth_getBlockByNumber")
          value = {
            hash: params[0] === "0x0" ? genesisHash : `0x${"2".repeat(64)}`,
            number: "0x1",
          };
        else if (method === "eth_getTransactionCount")
          value = model.retired ? "0x2" : "0x0";
        else if (method === "eth_getCode") value = "0x";
        else if (method === "txpool_content" && node === 2) {
          if (model.failRpc) {
            await route.fulfill({
              status: 503,
              body: "Simulated observer unavailable",
            });
            return;
          }
          if (model.schedule && model.started) {
            const elapsed = Date.now() - model.started;
            model.available = h1ArrivalScheduleMs.filter(
              (ms) => ms <= elapsed,
            ).length;
            model.retired = model.available === 20;
          }
          const transactions = inputs
            .slice(0, model.available)
            .map((input, i) => ({
              hash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
              input,
              nonce: "0x1",
              from: station,
            }));
          if (model.pendingClose)
            transactions.push({
              hash: `0x${"f".repeat(64)}`,
              input: "0x",
              nonce: "0x0",
              from: station,
            });
          value = { queued: { [station]: { "0x1": transactions } } };
        } else {
          model.forbidden.push(method);
          await route.abort();
          return;
        }
      } else {
        model.forbidden.push(path);
        await route.abort();
        return;
      }
      await route.fulfill({ json: value });
    });
  }
  async function open() {
    const model: Model = {
      available: 0,
      retired: false,
      pendingClose: false,
      failRpc: false,
      started: 0,
      schedule: false,
      reads: 0,
      forbidden: [],
    };
    const context = await browser.newContext();
    await context.addInitScript({ content: instrumentation });
    await mock(context, model);
    context.on("request", (req) => {
      const url = new URL(req.url());
      if (
        ![config.app, config.bridge].includes(url.origin) &&
        !["blob:", "data:"].includes(url.protocol)
      )
        errors.push(`External request: ${url.origin}`);
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${config.app}/h26/listen`);
    await page
      .getByRole("button", { name: "Attach independent listener" })
      .click();
    await expect(
      page.getByRole("button", { name: "Play Patio live media" }),
    ).toBeEnabled();
    return { context, page, model };
  }
  const play = (page: Page) =>
    page.getByRole("button", { name: "Play Patio live media" }).click();
  const status = (page: Page) =>
    page.locator('[role="status"]').filter({ has: page.locator("strong") });
  const audio = (page: Page) =>
    page.getByLabel("Patio live audio", { exact: true });
  async function progress(page: Page) {
    const before = await audio(page).evaluate(
      (el) => (el as HTMLAudioElement).currentTime,
    );
    await expect
      .poll(
        () =>
          audio(page).evaluate((el) => (el as HTMLAudioElement).currentTime),
        { timeout: 12000 },
      )
      .toBeGreaterThan(before + 0.4);
  }
  async function report(page: Page) {
    await page.getByText("Diagnóstico de emisión").click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar metadata JSON" }).click();
    const path = await (await download).path();
    assert(path);
    return JSON.parse(readFileSync(path, "utf8")) as {
      summary: Summary;
      events: { kind: string; details: Record<string, unknown> }[];
    };
  }
  async function finish(test: Awaited<ReturnType<typeof open>>, name: string) {
    assert.deepEqual(test.model.forbidden, []);
    const counters = await test.page.evaluate<{
      capture: number;
      wallet: number;
      sources: number;
      mediaSources: number;
    }>("window.__d3.counts");
    assert.equal(counters.capture, 0);
    assert.equal(counters.wallet, 0);
    assert(counters.sources <= 1);
    assert(counters.mediaSources <= 1);
    results.push({
      case: name,
      evidence: { counters, reads: test.model.reads },
    });
    await test.context.close();
  }
  try {
    // Early intent, pending close, recoverable play policy, pause, RPC failure,
    // pause-at-end and real remaining-audio drain without rebuilding MediaSource.
    const t = await open();
    assert.equal(await t.page.evaluate("window.__d3.counts.play"), 0);
    await t.page.evaluate("window.__d3.mode = 'blocked'");
    await play(t.page);
    await expect(status(t.page)).toContainText("Waiting for more audio");
    t.model.available = 3;
    t.model.pendingClose = true;
    await expect(
      t.page.getByRole("button", { name: "Enable audio" }),
    ).toBeVisible({ timeout: 12000 });
    const attempts = await t.page.evaluate("window.__d3.counts.play");
    t.model.available = 4;
    await t.page.waitForTimeout(1400);
    assert.equal(await t.page.evaluate("window.__d3.counts.play"), attempts);
    await t.page.evaluate("window.__d3.mode = 'normal'");
    await t.page.getByRole("button", { name: "Enable audio" }).click();
    await progress(t.page);
    await expect(status(t.page)).toContainText("Playing");
    t.model.failRpc = true;
    await expect(status(t.page)).toContainText("Connection unavailable", {
      timeout: 5000,
    });
    await progress(t.page);
    t.model.failRpc = false;
    await t.page
      .getByRole("button", { name: "Pause Patio live media" })
      .click();
    const pausedTime = await audio(t.page).evaluate(
      (el) => (el as HTMLAudioElement).currentTime,
    );
    t.model.available = 5;
    t.model.retired = true;
    await expect(status(t.page)).toContainText(
      "Broadcast ended — audio paused",
    );
    await t.page.waitForTimeout(700);
    assert.equal(
      await audio(t.page).evaluate(
        (el) => (el as HTMLAudioElement).currentTime,
      ),
      pausedTime,
    );
    await play(t.page);
    await progress(t.page);
    await expect
      .poll(
        () => audio(t.page).evaluate((el) => (el as HTMLAudioElement).ended),
        { timeout: 20000 },
      )
      .toBe(true);
    await expect(status(t.page)).toContainText("Playback finished");
    const ended = await report(t.page);
    assert.equal(ended.summary.midPlaybackSeeks, 0);
    await t.page.screenshot({
      path: join(directory, "d3-listener-finished.png"),
      fullPage: true,
    });
    results.push({ case: "real drain", evidence: ended.summary });
    await finish(
      t,
      "early Play / blocked policy / pending close / RPC continuity / paused end",
    );

    const late = await open();
    late.model.available = 3;
    late.model.retired = true;
    await expect(status(late.page)).toContainText(
      "Broadcast ended — audio available locally",
    );
    assert.equal(await late.page.evaluate("window.__d3.counts.play"), 0);
    await play(late.page);
    await progress(late.page);
    await expect
      .poll(
        () => audio(late.page).evaluate((el) => (el as HTMLAudioElement).ended),
        { timeout: 15000 },
      )
      .toBe(true);
    await finish(
      late,
      "never played until transport end; explicit Play drains",
    );

    const empty = await open();
    empty.model.retired = true;
    await expect(status(empty.page)).toContainText(
      "Broadcast ended — no playable audio received",
    );
    assert.equal(await empty.page.evaluate("window.__d3.counts.play"), 0);
    await expect(
      empty.page.getByRole("button", { name: "Play Patio live media" }),
    ).toBeDisabled();
    await finish(
      empty,
      "terminal without received audio; no impossible ended wait",
    );

    const pending = await open();
    await pending.page.evaluate("window.__d3.mode = 'pending'");
    await play(pending.page);
    pending.model.available = 3;
    await expect
      .poll(() => pending.page.evaluate("window.__d3.counts.play"), {
        timeout: 10000,
      })
      .toBe(1);
    await expect(status(pending.page)).not.toContainText("Playing");
    await pending.page
      .getByRole("button", { name: "Pause Patio live media" })
      .click();
    await pending.page.evaluate(
      "window.__d3.reject(new DOMException('simulated pause interruption','AbortError'))",
    );
    pending.model.available = 4;
    await pending.page.waitForTimeout(1400);
    await expect(status(pending.page)).toContainText("Paused by you");
    assert.equal(await pending.page.evaluate("window.__d3.counts.play"), 1);
    assert.equal(
      await audio(pending.page).evaluate(
        (el) => (el as HTMLAudioElement).paused,
      ),
      true,
    );
    await finish(
      pending,
      "append without progress; late play rejection cannot undo pause",
    );

    const duplicate = await open();
    await duplicate.page
      .getByRole("button", { name: "Play Patio live media" })
      .dblclick();
    await expect(status(duplicate.page)).toContainText("Paused by you");
    duplicate.model.available = 2;
    await duplicate.page.waitForTimeout(1400);
    assert.equal(await duplicate.page.evaluate("window.__d3.counts.play"), 0);
    await duplicate.page
      .getByRole("button", { name: "Attach independent listener" })
      .click();
    await expect(status(duplicate.page)).toContainText("Ready to listen");
    // Reattaching/resetting is not playback intent, nor another MediaSource.
    assert.equal(await duplicate.page.evaluate("window.__d3.counts.play"), 0);
    await finish(
      duplicate,
      "double click creates one source; reattach has no stale Play intent",
    );

    // H1/H2 same twenty arrivals, early and delayed Play in parallel. Real time;
    // no synthetic currentTime, playing/ended events or accelerated playback.
    const runSchedule = async (delayed: boolean) => {
      const s = await open();
      s.model.schedule = true;
      s.model.started = Date.now();
      if (delayed)
        await expect
          .poll(() => s.model.available, { timeout: 55000 })
          .toBeGreaterThanOrEqual(15);
      await play(s.page);
      if (!delayed) {
        await progress(s.page);
        await s.page
          .getByRole("button", { name: "Pause Patio live media" })
          .click();
        await s.page.waitForTimeout(500);
        await play(s.page);
      }
      await expect
        .poll(
          () => audio(s.page).evaluate((el) => (el as HTMLAudioElement).ended),
          { timeout: 85000 },
        )
        .toBe(true);
      const data = await report(s.page);
      assert.equal(data.summary.packetsReceived, 20);
      assert.equal(data.summary.appendsCompleted, 20);
      assert.equal(data.summary.transportEnded, true);
      assert.equal(data.summary.playbackEnded, true);
      assert.equal(data.summary.midPlaybackSeeks, 0);
      assert(Number(data.summary.initialPositioningSeeks) <= 1);
      assert(Number(data.summary.playRequestToPlaybackMs) > 0);
      if (!delayed) assert(Number(data.summary.interruptions) <= 1);
      else assert.equal(Number(data.summary.initialPositioningSeeks), 1);
      assert(
        !data.events.some(
          (e) =>
            e.kind === "playback-seek" &&
            e.details.reason === "live-edge-catch-up",
        ),
      );
      results.push({
        case: delayed ? "H1 late Play" : "H1 early Play",
        evidence: data.summary,
      });
      await finish(s, delayed ? "H1 late resources" : "H1 early resources");
    };
    await Promise.all([runSchedule(false), runSchedule(true)]);
    assert.deepEqual(errors, []);
    const actualHealth = (await (
      await fetch(`${config.bridge}/health`)
    ).json()) as { fundingAttempted: boolean; prepared: boolean };
    assert.equal(actualHealth.fundingAttempted, false);
    assert.equal(actualHealth.prepared, false);
    writeFileSync(
      join(directory, "d3-browser-check.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          scope:
            "real synthetic media / simulated listener RPC; no microphone or P2P",
          results,
          errors,
          actualHealth,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        ok: true,
        browser: browser.version(),
        cases: results.length,
        actualHealth,
      }),
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

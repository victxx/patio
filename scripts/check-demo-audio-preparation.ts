/** Explicit D2 browser regressions. Never run by demo:radio.
 * Virtual Chromium mic + real Web Audio; error APIs/recorder/funding simulated.
 * All financial endpoints intercepted; no real session funded or media sent.
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

const instrumentation = `(() => {
  const state = window.__d2 = { mode: 'normal', streams: [], pending: null, failStart: false, counts: { permissions: 0, recorders: 0, starts: 0, wallet: 0, play: 0, sameStream: false, audioOnly: true, copied: '' } };
  if (!navigator.mediaDevices) return;
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    state.counts.permissions++;
    state.counts.audioOnly &&= constraints.video === false && constraints.audio.channelCount === 1 && constraints.audio.echoCancellation === true;
    if (state.mode === 'denied' || state.mode === 'missing') throw new DOMException('simulated error', state.mode === 'denied' ? 'NotAllowedError' : 'NotFoundError');
    if (state.mode === 'pending') await new Promise(resolve => { state.pending = resolve; });
    const stream = await original(constraints); state.streams.push(stream); return stream;
  };
  const Recorder = window.MediaRecorder;
  window.MediaRecorder = class extends EventTarget {
    static isTypeSupported(mime) { return Recorder.isTypeSupported(mime); }
    constructor(stream) { super(); this.state = 'inactive'; state.counts.recorders++; state.counts.sameStream = stream === state.streams.at(-1); }
    start() { state.counts.starts++; if (state.failStart) throw new DOMException('simulated start failure', 'NotSupportedError'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; } // intentionally no chunks/cleanup scenario in this preparation test
  };
  Object.defineProperty(window, 'ethereum', { value: { request() { state.counts.wallet++; return Promise.reject(new Error('wallet forbidden')); } } });
  HTMLMediaElement.prototype.play = () => { state.counts.play++; return Promise.reject(new Error('play forbidden')); };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { state.counts.copied = text; } } });
})();`;
type Counts = {
  permissions: number;
  recorders: number;
  starts: number;
  wallet: number;
  play: number;
  sameStream: boolean;
  audioOnly: boolean;
  copied: string;
};
async function counts(page: Page) {
  return page.evaluate<Counts>("window.__d2.counts");
}

async function mockPrivateBridge(context: BrowserContext, bridge: string) {
  const ids = ["a".repeat(128), "b".repeat(128), "c".repeat(128)];
  const genesisHash = `0x${"1".repeat(64)}`;
  const model = {
    funds: 0,
    prepared: 0,
    sends: 0,
    ready: true,
    broken: false,
    uncertain: false,
    funded: false,
  };
  await context.route(`${bridge}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let value: unknown = null;
    if (path === "/health")
      value = {
        ready: model.ready,
        prepared: model.prepared > 0,
        fundingAttempted: model.funds > 0,
        reason: "B missing",
      };
    else if (path === "/manifest")
      value = {
        manifest: {
          kind: "patio-owned-prague-fixture",
          chainId: 1337,
          genesisHash,
          nodeIds: ids,
        },
        operator: `0x${"1".repeat(40)}`,
        fundingFeeCapWei: "63000000000000",
      };
    else if (path.startsWith("/rpc/")) {
      const node = Number(path.at(-1));
      const { method, params } = route.request().postDataJSON() as {
        method: string;
        params: string[];
      };
      if (method === "eth_chainId") value = "0x539";
      else if (method === "web3_clientVersion")
        value =
          node === 0 ? "Nethermind/v1.39.3+28cbe2a0" : "Geth/v1.17.5-9621c6ad";
      else if (method === "admin_nodeInfo") value = { id: ids[node] };
      else if (method === "admin_peers")
        value = model.broken
          ? []
          : ids.filter((_, i) => i !== node).map((id) => ({ id }));
      else if (method === "eth_syncing") value = false;
      else if (method === "eth_getBlockByNumber")
        value = {
          hash: params[0] === "0x0" ? genesisHash : `0x${"2".repeat(64)}`,
          number: "0x1",
          baseFeePerGas: "0x1",
        };
      else if (method === "eth_maxPriorityFeePerGas") value = "0x3b9aca00";
      else if (method === "eth_getCode") value = "0x";
      else if (method === "eth_getTransactionCount") value = "0x0";
      else if (method === "eth_getBalance")
        value = model.funded ? "0x11c37937e08000" : "0x0";
      else {
        model.sends++;
        throw new Error(`Forbidden/unexpected test RPC: ${method}`);
      }
    } else if (path === "/prepared") model.prepared++;
    else if (path === "/fund") {
      model.funds++;
      model.funded = true;
      if (model.uncertain) {
        await route.abort("failed");
        return;
      }
    } else
      assert(
        ["/review", "/event", "/snapshot"].includes(path),
        `Unexpected test endpoint ${path}`,
      );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
  return model;
}

async function main() {
  const directory = process.argv[2];
  assert(typeof directory === "string" && directory.startsWith("/"));
  const config = JSON.parse(
    readFileSync(join(directory, "launcher.json"), "utf8"),
  ) as { app: string; bridge: string };
  for (const origin of [config.app, config.bridge])
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const results: { case: string; evidence: unknown }[] = [];
  const errors: string[] = [];
  const external: string[] = [];
  async function open(mock = true) {
    const context = await browser.newContext();
    await context.addInitScript({ content: instrumentation });
    const model = mock
      ? await mockPrivateBridge(context, config.bridge)
      : undefined;
    context.on("request", (req) => {
      const url = new URL(req.url());
      if (
        ![config.app, config.bridge].includes(url.origin) &&
        !["blob:", "data:"].includes(url.protocol)
      )
        external.push(url.origin);
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${config.app}/h26`);
    await expect(
      page.getByText("Environment ready · waiting for your actions"),
    ).toBeVisible();
    return { context, page, model };
  }
  async function mic(page: Page) {
    await page.getByRole("button", { name: "Check microphone" }).click();
    await expect(
      page.getByText("Microphone available", { exact: true }),
    ).toBeVisible();
  }
  async function review(page: Page) {
    await page
      .getByLabel("Temporary exposure limit (private ETH)")
      .fill("0.002");
    await page
      .getByRole("button", { name: "Review plan", exact: true })
      .click();
    await page.getByRole("checkbox").check();
  }
  try {
    // Actual private bridge: only health and explicit read-only quote. Never /prepared or /fund.
    {
      const { context, page } = await open(false);
      const writes: string[] = [];
      page.on("request", (r) => {
        if (
          ["/prepared", "/fund", "/review"].includes(new URL(r.url()).pathname)
        )
          writes.push(new URL(r.url()).pathname);
      });
      expect(await counts(page)).toMatchObject({
        permissions: 0,
        recorders: 0,
        wallet: 0,
        play: 0,
      });
      await mic(page);
      await expect(page.getByRole("meter")).toBeVisible();
      await expect
        .poll(
          () =>
            page
              .getByRole("meter")
              .evaluate((meter: HTMLMeterElement) => meter.value),
          { timeout: 10000 },
        )
        .toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "Review plan", exact: true })
        .click();
      await expect(
        page.getByText(/Budget insufficient for this plan/),
      ).toBeVisible();
      await expect(
        page.getByLabel("Temporary exposure limit (private ETH)"),
      ).toHaveValue("0.0005");
      await expect(
        page.getByRole("button", { name: "Prepare session", exact: true }),
      ).toBeDisabled();
      expect(await counts(page)).toMatchObject({
        permissions: 1,
        recorders: 0,
        starts: 0,
        wallet: 0,
        play: 0,
        audioOnly: true,
      });
      expect(writes).toEqual([]);
      await page.screenshot({
        path: join(directory, "d2-microphone-review.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Turn microphone off" }).click();
      expect(
        await page.evaluate<string>(
          "window.__d2.streams[0].getAudioTracks()[0].readyState",
        ),
      ).toBe("ended");
      results.push({
        case: "real private read-only review + virtual microphone meter, no funding/recorder",
        evidence: await counts(page),
      });
      await context.close();
    }
    for (const mode of ["denied", "missing", "pending"]) {
      const { context, page, model } = await open();
      await page.evaluate(`window.__d2.mode = '${mode}'`);
      await page.getByRole("button", { name: "Check microphone" }).click();
      if (mode === "pending") {
        await expect(
          page.getByRole("button", { name: "Check microphone" }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Cancel local wait" }).click();
        await expect(
          page.getByRole("button", { name: "Check microphone" }),
        ).toBeDisabled();
        await page.evaluate("window.__d2.pending()");
        await expect
          .poll(() =>
            page.evaluate<string>(
              "window.__d2.streams[0]?.getAudioTracks()[0].readyState",
            ),
          )
          .toBe("ended");
      } else
        await expect(
          page.getByText(
            new RegExp(mode === "denied" ? "NotAllowedError" : "NotFoundError"),
          ),
        ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Prepare session", exact: true }),
      ).toBeDisabled();
      expect(model!.funds).toBe(0);
      expect(model!.prepared).toBe(0);
      expect((await counts(page)).permissions).toBe(1);
      results.push({
        case: `simulated ${mode} permission`,
        evidence: await counts(page),
      });
      await context.close();
    }
    {
      const { context, page, model } = await open();
      await mic(page);
      await review(page);
      model!.broken = true;
      await page
        .getByRole("button", { name: "Prepare session", exact: true })
        .click();
      await expect(
        page.getByText(/Private topology identity\/capability mismatch/),
      ).toBeVisible();
      expect(model!.funds).toBe(0);
      expect(model!.prepared).toBe(0);
      results.push({
        case: "topology changes after review",
        evidence: { fundingRequests: model!.funds },
      });
      await context.close();
    }
    {
      const { context, page, model } = await open();
      await mic(page);
      await review(page);
      model!.uncertain = true;
      await page
        .getByRole("button", { name: "Prepare session", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Reconcile funding (read only)" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Prepare session", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Reconcile funding (read only)" })
        .click();
      await expect(
        page.getByRole("button", { name: "Start now" }),
      ).toBeEnabled();
      expect(model!.funds).toBe(1);
      expect(model!.prepared).toBe(1);
      expect((await counts(page)).starts).toBe(0);
      results.push({
        case: "simulated uncertain funding, read-only reconciliation",
        evidence: {
          fundingRequests: model!.funds,
          sessionRegistrations: model!.prepared,
        },
      });
      await context.close();
    }
    {
      const { context, page, model } = await open();
      await mic(page);
      await review(page);
      await page
        .getByRole("button", { name: "Prepare session", exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      const start = page.getByRole("button", {
        name: "Start now",
        exact: true,
      });
      await expect(start).toBeEnabled();
      expect(model!.funds).toBe(1);
      expect(model!.prepared).toBe(1);
      expect((await counts(page)).recorders).toBe(0);
      await page
        .getByRole("button", { name: "Share link", exact: true })
        .click();
      expect((await counts(page)).copied).toBe(`${config.app}/h26/listen`);
      expect((await counts(page)).starts).toBe(0);
      const popup = page.waitForEvent("popup");
      await page
        .getByRole("link", { name: "Open this session’s listener" })
        .click();
      await (await popup).close();
      expect((await counts(page)).starts).toBe(0);
      await page.getByRole("button", { name: "Turn microphone off" }).click();
      await expect(start).toBeDisabled();
      await mic(page);
      await expect(start).toBeEnabled();
      expect(model!.funds).toBe(1);
      await page.evaluate("window.__d2.failStart = true");
      await start.click();
      await expect(page.getByText(/NotSupportedError:/)).toBeVisible();
      await expect(start).toBeDisabled();
      expect(model!.funds).toBe(1);
      await page.evaluate("window.__d2.failStart = false");
      await mic(page);
      const before = await counts(page);
      await start.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect(
        page.getByText("Live on isolated private fixture", { exact: true }),
      ).toBeVisible();
      const after = await counts(page);
      expect(after.permissions).toBe(before.permissions);
      expect(after.starts - before.starts).toBe(1);
      expect(after.recorders - before.recorders).toBe(1);
      expect(after.sameStream).toBe(true);
      expect(after.wallet).toBe(0);
      expect(after.play).toBe(0);
      expect(
        await page.evaluate<string>(
          "window.__d2.streams.at(-1).getAudioTracks()[0].readyState",
        ),
      ).toBe("live");
      expect(model!.sends).toBe(0);
      expect(model!.funds).toBe(1);
      results.push({
        case: "simulated funded session retained across mic off/start error; single recorder handoff",
        evidence: {
          before,
          after,
          fundingRequests: model!.funds,
          rawSends: model!.sends,
        },
      });
      await context.close();
    }
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    const health = (await (await fetch(`${config.bridge}/health`)).json()) as {
      prepared: boolean;
      fundingAttempted: boolean;
      sends: number;
    };
    expect(health).toMatchObject({
      prepared: false,
      fundingAttempted: false,
      sends: 0,
    });
    writeFileSync(
      join(directory, "d2-browser-check.json"),
      JSON.stringify(
        {
          result: "PASS",
          browser: browser.version(),
          physicalMicrophone: "NOT RUN",
          capture: "Chromium virtual microphone, real Web Audio",
          recordingAndFinancialErrors:
            "simulated APIs and bridge; no real funded session",
          results,
          errors,
          external,
          actualBridgeHealth: health,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      `D2 browser PASS: ${results.length} cases; virtual microphone, simulated funding/start; actual bridge unfunded.`,
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/** Attach only to the newly owned H2.6 browser. ONE run, no retries or mock media. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:19226");
  const pages = browser.contexts()[0]!.pages();
  const caster = pages.find((p) => p.url() === "http://127.0.0.1:3106/h26");
  const listener = pages.find(
    (p) => p.url() === "http://127.0.0.1:3106/h26/listen",
  );
  assert(caster && listener, "Existing owned fixture windows required");
  const errors: string[] = [];
  for (const page of [caster, listener])
    page.on("pageerror", (e) => errors.push(e.message));
  const samples: unknown[] = [];
  await listener
    .getByText("Independent observer C — real pending transactions")
    .waitFor();
  await caster.getByRole("button", { name: "Start now", exact: true }).click();
  console.log("REAL MICROPHONE RUN STARTED — speak now");
  await listener
    .getByRole("button", { name: "Play Patio live media", exact: true })
    .waitFor({ state: "visible" });
  await listener
    .getByRole("button", { name: "Play Patio live media", exact: true })
    .click({ timeout: 20000 });
  console.log("LISTENER PLAY REQUESTED");
  const start = performance.now();
  for (let i = 0; i < 55; i++) {
    const state = await listener
      .locator("audio")
      .evaluate((audio: HTMLAudioElement) => ({
        currentTime: audio.currentTime,
        ended: audio.ended,
        paused: audio.paused,
        readyState: audio.readyState,
        muted: audio.muted,
        volume: audio.volume,
        buffered: Array.from({ length: audio.buffered.length }, (_, i) => [
          audio.buffered.start(i),
          audio.buffered.end(i),
        ]),
      }));
    samples.push({ atMs: performance.now() - start, ...state });
    if (i % 5 === 0) console.log(JSON.stringify(state));
    if (state.ended) break;
    await delay(1000);
  }
  for (const [page, role] of [
    [caster, "caster"],
    [listener, "listener"],
  ] as const) {
    await page.getByText("Diagnóstico de emisión", { exact: true }).click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Exportar metadata JSON", exact: true })
      .click();
    await (await download).saveAs(`reports/h26-private-audio-${role}.json`);
  }
  await caster
    .getByRole("button", { name: "Save private session proof" })
    .click();
  await caster.getByText(/Proof retained:/).waitFor({ timeout: 10000 });
  writeFileSync(
    "reports/h26-private-browser.json",
    JSON.stringify(
      {
        browser: browser.version(),
        capture:
          "real getUserMedia audio, no fake-device flag or injected stream",
        samples,
        errors,
        casterText: await caster.locator("main").innerText(),
        listenerText: await listener.locator("main").innerText(),
      },
      null,
      2,
    ),
  );
  console.log("ONE RUN EVIDENCE EXPORTED — no repeat");
  process.exit(0);
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Browser check failed",
  );
  process.exit(1);
});

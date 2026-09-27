/** Explicit D1 read-only browser check; never invoked by demo:radio. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

async function main() {
  const directory = process.argv[2];
  assert(
    typeof directory === "string" && directory.startsWith("/"),
    "Provide this launcher's owned output directory",
  );
  const config = JSON.parse(
    readFileSync(join(directory, "launcher.json"), "utf8"),
  ) as { app: string; bridge: string };
  for (const origin of [config.app, config.bridge])
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const readHealth = async () => {
    const response = await fetch(`${config.bridge}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    assert(response.ok);
    return (await response.json()) as {
      ready: boolean;
      prepared: boolean;
      fundingAttempted: boolean;
      sends: number;
    };
  };
  const before = await readHealth();
  assert(
    before.ready &&
      !before.prepared &&
      !before.fundingAttempted &&
      before.sends === 0,
  );
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const errors: string[] = [];
  const external: string[] = [];
  const mutations: string[] = [];
  try {
    await context.addInitScript({
      content: `(() => {
      const counts = { media: 0, wallet: 0, play: 0 };
      Object.assign(window, { __d1Counts: counts });
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
        counts.media++;
        return Promise.reject(new Error("Unexpected permission attempt"));
      };
      Object.defineProperty(window, "ethereum", {
        value: {
          request: () => {
            counts.wallet++;
            return Promise.reject(new Error("Unexpected wallet request"));
          },
        },
      });
      HTMLMediaElement.prototype.play = () => {
        counts.play++;
        return Promise.reject(new Error("Unexpected autoplay"));
      };
    })();`,
    });
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (
        ![config.app, config.bridge].includes(url.origin) &&
        !["data:", "blob:"].includes(url.protocol)
      )
        external.push(url.origin);
      if (request.method() !== "GET" && request.method() !== "OPTIONS")
        mutations.push(url.pathname);
    });
    const caster = await context.newPage();
    await caster.goto(`${config.app}/h26`);
    await expect(
      caster.getByText("Environment ready · waiting for your actions"),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      caster.getByRole("button", { name: "Check microphone" }),
    ).toBeEnabled();
    await expect(
      caster.getByRole("button", { name: "Prepare session", exact: true }),
    ).toBeDisabled();
    await expect(
      caster.getByRole("link", { name: "Open this session’s listener" }),
    ).toHaveCount(0);
    await caster.screenshot({
      path: join(directory, "d1-ready.png"),
      fullPage: true,
    });
    const listener = await context.newPage();
    await listener.goto(`${config.app}/h26/listen`);
    await expect(
      listener.getByText("Environment ready · waiting for your actions"),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      listener.getByRole("button", { name: "Attach independent listener" }),
    ).toBeEnabled();
    const counts = await Promise.all(
      [caster, listener].map((page) =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __d1Counts: { media: number; wallet: number; play: number };
              }
            ).__d1Counts,
        ),
      ),
    );
    expect(counts).toEqual([
      { media: 0, wallet: 0, play: 0 },
      { media: 0, wallet: 0, play: 0 },
    ]);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(mutations).toEqual([]);
    const after = await readHealth();
    assert(
      after.ready &&
        !after.prepared &&
        !after.fundingAttempted &&
        after.sends === 0,
    );
    writeFileSync(
      join(directory, "d1-browser-check.json"),
      JSON.stringify(
        {
          result: "PASS",
          browser: browser.version(),
          before,
          after,
          counts,
          errors,
          external,
          mutations,
          fundedRun: "NOT RUN",
          microphone: "NOT RUN",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      "D1 browser PASS: actual pages/controls; zero permission, wallet, play, mutation or external request; no session/funding/sends.",
    );
  } finally {
    await context.close();
    await browser.close();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

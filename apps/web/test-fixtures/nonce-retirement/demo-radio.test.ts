import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import {
  canStopDemo,
  cleanDemoEnvironment,
  demoSourceFile,
  portAvailable,
} from "../../../../scripts/demo-radio-support";

describe("D1 manual private launcher boundaries", () => {
  it("copies local source, not credentials, runtime evidence or media", () => {
    for (const path of [
      "apps/web/test-fixtures/nonce-retirement/full-app-host.tsx",
      "apps/web/app/fonts/terminal-grotesque.ttf",
      "package.json",
      ".prettierignore",
    ])
      expect(demoSourceFile(path)).toBe(true);
    for (const path of [
      ".env",
      "apps/web/.env.local",
      "reports/key.json",
      "data/session.json",
      "apps/web/.next/cache/test.json",
      "node_modules/a/index.js",
      "audio.webm",
      "recording.wav",
      "infra/hoodi/operator.env",
      "datadir/keystore/account.json",
    ])
      expect(demoSourceFile(path)).toBe(false);
  });
  it("build environment does not inherit public credentials or feature flags", () => {
    const env = cleanDemoEnvironment("http://127.0.0.1:19780");
    expect(
      Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_")),
    ).toEqual([
      "NEXT_PUBLIC_PATIO_REACTION_RELAYS",
      "NEXT_PUBLIC_PATIO_PRIVATE_BRIDGE",
    ]);
    expect(env.NEXT_PUBLIC_PATIO_REACTION_RELAYS).toBe("");
    expect(env.TURBO_FORCE).toBe("true");
  });
  it("port conflict leaves the existing server alive", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
      expect(await portAvailable(address.port)).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("shutdown holds any uncertain or unfinished funded session", () => {
    expect(canStopDemo({ fundingAttempted: false, complete: false })).toBe(
      true,
    );
    expect(canStopDemo({ fundingAttempted: true, complete: false })).toBe(
      false,
    );
    expect(canStopDemo({ fundingAttempted: true, complete: true })).toBe(true);
  });
  it("launcher does not invoke the scenario or any preparation/funding endpoint", () => {
    const source = readFileSync(
      new URL("../../../../scripts/demo-radio.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "full-app-browser",
      "playwright",
      '"/fund"',
      '"/prepared"',
      "getUserMedia",
      "eth_sendRawTransaction",
    ])
      expect(source).not.toContain(forbidden);
    expect(source).toContain("full-app-server.ts");
    expect(source).toMatch(/"--hostname",\s*"127\.0\.0\.1"/);
    expect(source).toContain("connect-src 'self'");
  });
});

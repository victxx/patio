/** Build/serve the REAL application in an isolated source/output directory.
 * No scenario runner, accounts, funding, capture or browser automation. */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  copyDemoSources,
  portAvailable,
} from "../../../../scripts/demo-radio-support";

async function main() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw Error("Node 24 required");
  const root = resolve(import.meta.dirname, "../../../..");
  const secret = readFileSync(join(root, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("PATIO_HOODI_QUICKNODE_RPC_URL="))
    ?.split("=")
    .slice(1)
    .join("=")
    .replace(/^["']|["']$/g, "");
  if (!secret) throw Error("Protected QuickNode configuration missing");
  let port = 3220;
  while (port < 3230 && !(await portAvailable(port))) port++;
  if (port === 3230)
    throw Error("No free isolated app port; existing processes untouched");
  const work = mkdtempSync(join(tmpdir(), "patio-quicknode-audio-"));
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 10_000_000 },
  )
    .split("\0")
    .filter(Boolean);
  copyDemoSources(root, work, files);
  const app = join(work, "apps/web/app");
  writeFileSync(
    join(app, "cast/page.tsx"),
    'import Host from "../../test-fixtures/hoodi-hash-canary/audio-host";\nexport default function Page(){return <Host/>;}\n',
  );
  writeFileSync(
    join(app, "page.tsx"),
    'import Host from "../test-fixtures/hoodi-hash-canary/audio-host";\nexport default function Page(){return <Host listener/>;}\n',
  );
  mkdirSync(join(app, "api/local-audio"), { recursive: true });
  writeFileSync(
    join(app, "api/local-audio/route.ts"),
    'export { POST } from "../../../test-fixtures/hoodi-hash-canary/audio-adapter";\nexport const runtime="nodejs";\nexport const dynamic="force-dynamic";\n',
  );
  const env = {
    NODE_ENV: "production",
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(PATIO_|NEXT_PUBLIC_|VERCEL)/.test(key),
      ),
    ),
  } as NodeJS.ProcessEnv;
  Object.assign(env, {
    PATIO_LOCAL_QUICKNODE_AUDIO: "1",
    PATIO_LOCAL_AUDIO_ORIGIN: `http://127.0.0.1:${port}`,
    PATIO_HOODI_QUICKNODE_RPC_URL: secret,
    NEXT_PUBLIC_HOODI_RELAY_RPC_URL: "/api/local-audio",
    NEXT_PUBLIC_HOODI_OBSERVER_RPC_URL: "/api/local-audio",
    // The existing reactions widget is outside this controlled audio test.
    NEXT_PUBLIC_PATIO_REACTION_RELAYS: "",
  });
  console.log(
    `Isolated real application build: ${work}. No account or funding created.`,
  );
  execFileSync("pnpm", ["--filter", "@patio/web", "build"], {
    cwd: work,
    env,
    stdio: "inherit",
  });
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@patio/web",
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: work, env, stdio: "inherit" },
  );
  console.log(
    `Controlled Hoodi audio URL: http://127.0.0.1:${port}/cast\nQuickNode same-service. Connect → Check microphone → Review. Approve the exact review before wallet funding. Stop only after return/reconciliation and diagnostics export. Preserve funded tabs and this process.`,
  );
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  // No automatic retries/restarts, node launches, cleanup or state deletion.
}
void main().catch(() => {
  console.error(
    "Controlled app failed to build/start. Existing instances were not touched; no funding attempted.",
  );
  process.exitCode = 1;
});

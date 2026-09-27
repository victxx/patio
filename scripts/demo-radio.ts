/** Manual private host. Never imports/invokes the browser scenario runner. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  canStopDemo,
  cleanDemoEnvironment,
  copyDemoSources,
  selectDemoPorts,
} from "./demo-radio-support";

const root = resolve(import.meta.dirname, "..");
const children: ChildProcess[] = [];
let bridgeProcess: ChildProcess | undefined;
let bridge = "";
let stopping = false;
let locked = false;
let work = "";
let uiServed = false;
const lock = join(
  tmpdir(),
  `patio-radio-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.lock`,
);
const lockFile = join(lock, "owner.json");
const alive = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

function launch(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  name: string,
) {
  const fd = openSync(join(work, `${name}.log`), "a", 0o600);
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
  child.on("error", () =>
    console.error(
      `${name}: process could not start; inspect the owned local log.`,
    ),
  );
  return child;
}
async function waitExit(child: ChildProcess) {
  return new Promise<number | null>((resolveExit) => {
    child.once("exit", resolveExit);
    child.once("error", () => resolveExit(-1));
  });
}
async function health() {
  const response = await fetch(`${bridge}/health`, {
    signal: AbortSignal.timeout(8000),
  });
  assert(response.ok);
  return (await response.json()) as {
    ready: boolean;
    reason?: string;
    fundingAttempted: boolean;
    complete: boolean;
  };
}
async function stop() {
  if (stopping) return;
  if (uiServed) {
    if (!bridgeProcess || !alive(bridgeProcess)) {
      console.error(
        "STOP BLOCKED: bridge exited; session state unknown. Preserve browser and owned processes for reconciliation.",
      );
      return;
    }
    try {
      if (!canStopDemo(await health())) {
        console.error(
          "STOP BLOCKED: finish/close the broadcast in Patio, then Save private session proof. Keep the browser and these processes open; no automatic recovery.",
        );
        return;
      }
    } catch {
      console.error(
        "STOP BLOCKED: session state unknown. Preserve processes and browser; reconcile before stopping.",
      );
      return;
    }
  }
  stopping = true;
  for (const child of [...children].reverse()) {
    if (!alive(child)) continue;
    // Only handles created by this launcher; never kill by port or process name.
    child.kill("SIGTERM");
    await Promise.race([waitExit(child), delay(7000)]);
  }
  if (children.some(alive)) {
    console.error(
      "Owned processes still running; state retained. No force-kill performed.",
    );
    stopping = false;
    return;
  }
  if (locked) {
    unlinkSync(lockFile);
    rmdirSync(lock);
    locked = false;
  }
  console.log(
    `Stopped owned demo processes. Local artifacts retained: ${work}`,
  );
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});

async function main() {
  assert.equal(
    process.versions.node.split(".")[0],
    "24",
    "DEPENDENCY: Node 24 required; do not change the repository engine",
  );
  const tools = {
    PATIO_H23_GETH:
      process.env.PATIO_H23_GETH ?? "/private/tmp/patio-h26-tools/geth-1.17.5",
    PATIO_H23_NETHERMIND:
      process.env.PATIO_H23_NETHERMIND ??
      "/private/tmp/patio-h26-tools/nethermind/nethermind",
    PATIO_H23_GETH_SOURCE:
      process.env.PATIO_H23_GETH_SOURCE ??
      "/private/tmp/patio-h26-tools/go-ethereum-1.17.5",
  };
  for (const [name, path] of Object.entries(tools))
    assert(
      existsSync(path),
      `DEPENDENCY: ${name} missing; supply the already-pinned local tool, no automatic install`,
    );
  assert(
    existsSync(join(root, "node_modules/.bin/tsx")),
    "DEPENDENCY: installed workspace dependencies required",
  );
  try {
    mkdirSync(lock, { mode: 0o700 });
    locked = true;
  } catch {
    let owner: { pid?: number; url?: string } = {};
    try {
      owner = JSON.parse(readFileSync(lockFile, "utf8")) as typeof owner;
    } catch {
      /* incomplete lock: fail closed */
    }
    throw new Error(
      `DEMO_LOCKED: existing/retained launcher pid ${owner.pid ?? "unknown"}, URL ${owner.url ?? "not ready"}. Inspect it; no process or state was removed.`,
    );
  }
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, url: "preparing" }),
    { mode: 0o600 },
  );
  const ports = await selectDemoPorts();
  const app = `http://127.0.0.1:${ports.app}`;
  bridge = `http://127.0.0.1:${ports.bridge}`;
  work = mkdtempSync(join(tmpdir(), "patio-radio-demo-"));
  const source = join(work, "source");
  mkdirSync(source);
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, url: `${app}/h26`, work }),
    { mode: 0o600 },
  );
  console.log(
    `Preparing isolated private demo${ports.alternate ? " (occupied ports left untouched; using alternative ports)" : ""}. Build/log directory: ${work}`,
  );
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 10_000_000 },
  )
    .split("\0")
    .filter(Boolean);
  copyDemoSources(root, source, files);
  const route = join(source, "apps/web/app/h26");
  mkdirSync(join(route, "listen"), { recursive: true });
  writeFileSync(
    join(route, "page.tsx"),
    'export { default } from "../../test-fixtures/nonce-retirement/full-app-host";\n',
  );
  writeFileSync(
    join(route, "listen/page.tsx"),
    'export { default } from "../../../test-fixtures/nonce-retirement/full-app-host";\n',
  );
  // Defense-in-depth for the isolated bundle, never edit active/public config.
  const config = join(source, "apps/web/next.config.ts");
  const originalConfig = readFileSync(config, "utf8");
  assert(originalConfig.includes("export default nextConfig;"));
  writeFileSync(
    config,
    originalConfig.replace(
      "export default nextConfig;",
      `nextConfig.headers = async () => [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "connect-src 'self' ${bridge}; object-src 'none'" }] }];\nexport default nextConfig;`,
    ),
  );
  const env = { ...cleanDemoEnvironment(bridge), ...tools };
  // Generated route/config are formatted before the optional full verification.
  execFileSync(
    "pnpm",
    [
      "exec",
      "prettier",
      "--write",
      "apps/web/app/h26",
      "apps/web/next.config.ts",
    ],
    { cwd: source, env, stdio: "ignore" },
  );
  const verify = process.argv.includes("--verify");
  console.log(
    verify
      ? "Running pnpm verify in the isolated copy (including fresh Webpack build)…"
      : "Building the real app with Webpack in the isolated copy…",
  );
  const build = launch(
    "pnpm",
    [verify ? "verify" : "build"],
    source,
    env,
    "build",
  );
  assert.equal(
    await waitExit(build),
    0,
    "BUILD_FAILED: inspect build.log; existing servers/output untouched",
  );
  bridgeProcess = launch(
    process.execPath,
    [
      "--import",
      "tsx",
      "apps/web/test-fixtures/nonce-retirement/full-app-server.ts",
    ],
    source,
    {
      ...env,
      PATIO_H26_REPORT: join(work, "private-proof.json"),
      PATIO_PRIVATE_RPC_BASE: String(ports.rpcBase),
      PATIO_PRIVATE_BRIDGE_PORT: String(ports.bridge),
      PATIO_PRIVATE_APP_ORIGIN: app,
      PATIO_PRIVATE_MANUAL_DEMO: "1",
    },
    "private-nodes",
  );
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && alive(bridgeProcess)) {
    try {
      ready = (await health()).ready;
    } catch {
      /* server not yet listening; no session exists */
    }
    if (ready) break;
    await delay(500);
  }
  assert(
    ready,
    "TOPOLOGY_BLOCKED: pinned client/genesis/identity/12-second readiness failed; inspect private-nodes.log",
  );
  uiServed = true;
  const web = launch(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(ports.app),
    ],
    join(source, "apps/web"),
    env,
    "web",
  );
  let serving = false;
  for (let i = 0; i < 40 && alive(web); i++) {
    try {
      serving = (
        await fetch(`${app}/h26`, { signal: AbortSignal.timeout(2000) })
      ).ok;
    } catch {
      /* bounded readiness */
    }
    if (serving) break;
    await delay(250);
  }
  assert(
    serving,
    "WEB_BLOCKED: production server unavailable; inspect web.log",
  );
  console.log(
    `READY: ${app}/h26\nLocal private demo · not Hoodi · test funds\nNo session created or funded. No browser scenario, wallet, microphone or playback started.\nThe session listener link appears only after manual preparation. Four candidates; quote uses the current planner.\nFinish the broadcast in Patio and save the proof BEFORE stopping this launcher with Ctrl-C. Never close a tab holding an unresolved session.\nPrivate bridge: ${bridge} · read-only health: /health`,
  );
  writeFileSync(
    join(work, "launcher.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        app,
        bridge,
        ports,
        verify,
        pid: process.pid,
        webPid: web.pid,
        bridgePid: bridgeProcess.pid,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // Long-running manual service: no scenario, session creation, or restart loop.
  for (const child of [web, bridgeProcess])
    child.once("exit", () => {
      if (!stopping)
        console.error(
          "Owned service exited. No restart or provider fallback. Preserve any session tab and reconcile before shutdown.",
        );
    });
}
main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : "DEMO_BLOCKED");
  process.exitCode = 1;
  // Before the UI is served there cannot be a user session. A live bridge with
  // unknown state is deliberately retained by stop(), never force-destroyed.
  if (locked) await stop();
});

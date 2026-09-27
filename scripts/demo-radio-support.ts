import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only source/config assets; never clone runtime state, secrets or recordings. */
export function demoSourceFile(path: string): boolean {
  if ([".prettierignore", ".gitignore"].includes(path)) return true;
  // Checked-in, 1.6 KiB metadata-only digest fixture required by relay tests.
  // Contains no media/raw signatures/keys/URLs (cleanup input is only "0x").
  if (path === "docs/reports/hoodi-managed-rpc-proof-2026-08-21.json")
    return true;
  if (
    path
      .split("/")
      .some((part) =>
        /^(node_modules|dist|reports|test-results|playwright-report|coverage|\.git|\.next.*|\.turbo|\.contract-build)$/.test(
          part,
        ),
      )
  )
    return false;
  if (/(^|\/)\.env(?:\.|$)/.test(path)) return false;
  if (
    !/^(apps|packages|scripts|contracts|infra|docs)\//.test(path) &&
    path.includes("/")
  )
    return false;
  return /\.(ts|tsx|js|mjs|cjs|json|yaml|yml|css|sol|sh|html|svg|png|woff2?|ttf|md|txt|example)$/.test(
    path,
  );
}

export function copyDemoSources(root: string, target: string, files: string[]) {
  for (const file of files.filter(demoSourceFile)) {
    const destination = join(target, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, file), destination, { dereference: false });
  }
  // Reuse installed dependencies, never install/download or copy their caches.
  const workspaces = new Set([
    "",
    ...files
      .filter((f) => /^(apps|packages)\/[^/]+\/package\.json$/.test(f))
      .map(dirname),
  ]);
  for (const workspace of workspaces) {
    const installed = join(root, workspace, "node_modules");
    if (existsSync(installed)) {
      mkdirSync(join(target, workspace), { recursive: true });
      symlinkSync(installed, join(target, workspace, "node_modules"), "dir");
    }
  }
}

export async function portAvailable(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function selectDemoPorts() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const app = 3118 + attempt * 100;
    const bridge = 19780 + attempt * 100;
    const rpcBase = 19647 + attempt * 100;
    const ports = [
      app,
      bridge,
      ...[0, 1, 2].flatMap((slot) =>
        [0, 1, 2].map((offset) => rpcBase + slot * 10 + offset),
      ),
    ];
    if (
      (
        await Promise.all(
          ports.flatMap((port) => [
            portAvailable(port),
            portAvailable(port, "::1"),
          ]),
        )
      ).every(Boolean)
    )
      return { app, bridge, rpcBase, alternate: attempt > 0 };
  }
  throw new Error(
    "PORT_CONFLICT: no free private port set; no existing process was stopped",
  );
}

export function cleanDemoEnvironment(bridge: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    TURBO_FORCE: "true",
    npm_config_verify_deps_before_run: "false",
    npm_config_manage_package_manager_versions: "false",
    npm_config_update_notifier: "false",
    pnpm_config_verify_deps_before_run: "false",
    pnpm_config_manage_package_manager_versions: "false",
    pnpm_config_update_notifier: "false",
    NEXT_PUBLIC_PATIO_REACTION_RELAYS: "",
    NEXT_PUBLIC_PATIO_PRIVATE_BRIDGE: bridge,
  };
}

export function canStopDemo(health: {
  fundingAttempted: boolean;
  complete: boolean;
}): boolean {
  return !health.fundingAttempted || health.complete;
}

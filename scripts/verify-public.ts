const HOODI_CHAIN_ID = 560_048;
const ZERO = "0";

interface HealthResponse {
  status?: unknown;
  service?: unknown;
  executionClient?: unknown;
  chainId?: unknown;
  blockNumber?: unknown;
  peerCount?: unknown;
  syncing?: unknown;
  txpoolAvailable?: unknown;
  mainnetEnabled?: unknown;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function publicBaseUrl(name: string): URL {
  const url = new URL(required(name));
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.pathname !== "/") {
    throw new Error(`${name} must be an origin without a path`);
  }
  return url;
}

function integer(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a decimal integer string`);
  }
  return BigInt(value);
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function json<T>(
  base: URL,
  path: string,
  webOrigin: string,
): Promise<{ body: T; cors: string | null }> {
  const response = await fetch(new URL(path, base), {
    headers: { origin: webOrigin },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    throw new Error(
      `${base.origin}${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  if (body === null) throw new Error(`${base.origin}${path} returned no JSON`);
  return {
    body,
    cors: response.headers.get("access-control-allow-origin"),
  };
}

function validateHealth(
  health: HealthResponse,
  expectedService: string,
  expectedClient: string,
  requireTxpool: boolean,
): { blockNumber: bigint; peerCount: bigint } {
  assert(health.status === "ok", `${expectedService} is not healthy`);
  assert(
    health.service === expectedService,
    `Expected ${expectedService}, received ${String(health.service)}`,
  );
  assert(
    health.chainId === HOODI_CHAIN_ID,
    `${expectedService} is not on Hoodi`,
  );
  assert(
    typeof health.executionClient === "string" &&
      health.executionClient.toLowerCase().includes(expectedClient),
    `${expectedService} is not backed by ${expectedClient}`,
  );
  assert(health.syncing === false, `${expectedService} is still syncing`);
  if (requireTxpool) {
    assert(
      health.txpoolAvailable === true,
      `${expectedService} cannot read txpool_contentFrom`,
    );
  }
  const blockNumber = integer(health.blockNumber, `${expectedService} block`);
  const peerCount = integer(health.peerCount, `${expectedService} peer count`);
  assert(peerCount > 0n, `${expectedService} has no Ethereum peers`);
  return { blockNumber, peerCount };
}

async function main(): Promise<void> {
  const relay = publicBaseUrl("PATIO_RELAY_URL");
  const observer = publicBaseUrl("PATIO_OBSERVER_URL");
  const webOrigin = new URL(required("PATIO_WEB_ORIGIN")).origin;
  assert(
    relay.hostname !== observer.hostname,
    "Relay and observer must use different public hosts",
  );

  const [relayHealthResult, observerHealthResult] = await Promise.all([
    json<HealthResponse>(relay, "/healthz", webOrigin),
    json<HealthResponse>(observer, "/healthz", webOrigin),
  ]);
  assert(
    relayHealthResult.cors === webOrigin,
    `Relay CORS does not allow ${webOrigin}`,
  );
  assert(
    observerHealthResult.cors === webOrigin,
    `Observer CORS does not allow ${webOrigin}`,
  );
  const relayHealth = validateHealth(
    relayHealthResult.body,
    "patio-relay",
    "nethermind",
    false,
  );
  const observerHealth = validateHealth(
    observerHealthResult.body,
    "patio-observer",
    "geth",
    true,
  );
  assert(
    relayHealthResult.body.mainnetEnabled === false,
    "Mainnet must remain disabled during the Hoodi rehearsal",
  );

  const blockGap =
    relayHealth.blockNumber > observerHealth.blockNumber
      ? relayHealth.blockNumber - observerHealth.blockNumber
      : observerHealth.blockNumber - relayHealth.blockNumber;
  assert(blockGap <= 4n, `Independent nodes are ${blockGap} blocks apart`);

  const [fees, broadcasts] = await Promise.all([
    json<{ canStart?: unknown; maximumExposureWei?: unknown }>(
      relay,
      "/v1/fees",
      webOrigin,
    ),
    json<{ broadcasts?: unknown }>(observer, "/v1/broadcasts", webOrigin),
  ]);
  assert(
    fees.cors === webOrigin && broadcasts.cors === webOrigin,
    "Public APIs do not allow the configured web origin",
  );
  assert(
    typeof fees.body.maximumExposureWei === "string" &&
      fees.body.maximumExposureWei !== ZERO,
    "Relay fee planner is unavailable",
  );
  assert(
    Array.isArray(broadcasts.body.broadcasts),
    "Observer broadcast catalog is unavailable",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ready: true,
        chainId: HOODI_CHAIN_ID,
        webOrigin,
        relay: {
          origin: relay.origin,
          client: relayHealthResult.body.executionClient,
          blockNumber: relayHealth.blockNumber.toString(),
          peerCount: relayHealth.peerCount.toString(),
        },
        observer: {
          origin: observer.origin,
          client: observerHealthResult.body.executionClient,
          blockNumber: observerHealth.blockNumber.toString(),
          peerCount: observerHealth.peerCount.toString(),
          txpoolAvailable: true,
        },
        blockGap: blockGap.toString(),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Patio public transport is not ready: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

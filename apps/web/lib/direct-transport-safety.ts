export const DIRECT_TRANSPORT_SAFETY_INCIDENT = "hoodi-h2.1-media-inclusion";

export const DIRECT_TRANSPORT_SAFETY_BLOCK_MESSAGE =
  "New public-network Patio broadcasts are paused after canonical media inclusion was observed. Existing sessions remain available for read-only reconciliation; no new preparation or funding is allowed.";

/**
 * H2.2: a loopback URL may tunnel to a public chain. No URL, environment flag,
 * or self-reported chain ID establishes isolation. The actual browser action
 * stays closed; isolated executor/media fixtures do not call this action.
 */
export function assertNewDirectBroadcastAllowed(_input: {
  senderRpcUrl: string;
  observerRpcUrl: string;
  chainId?: number;
  hoodiBeta?: boolean;
}): void {
  if (
    _input.hoodiBeta === true &&
    _input.chainId === 560048 &&
    _input.senderRpcUrl === "/api/hoodi-beta" &&
    _input.observerRpcUrl === "/api/hoodi-beta"
  )
    return;
  throw new Error(DIRECT_TRANSPORT_SAFETY_BLOCK_MESSAGE);
}

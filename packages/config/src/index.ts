export const PATIO_TEST_NETWORK = {
  id: "hoodi",
  name: "Hoodi",
  chainId: 560048,
  currency: "ETH",
  mode: "testnet",
  maxSessionExposureWei: 5_000_000_000_000_000n,
} as const;

export type PatioNetwork = typeof PATIO_TEST_NETWORK;

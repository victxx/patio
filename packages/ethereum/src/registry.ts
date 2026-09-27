export const PATIO_REGISTRY_ABI = [
  {
    type: "function",
    name: "approvedOperators",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ name: "approved", type: "bool" }],
  },
  {
    type: "function",
    name: "streamOperators",
    stateMutability: "view",
    inputs: [{ name: "streamId", type: "bytes16" }],
    outputs: [{ name: "operator", type: "address" }],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "announce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "streamId", type: "bytes16" },
      { name: "session", type: "address" },
      { name: "nonceStart", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "mediaMode", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "end",
    stateMutability: "nonpayable",
    inputs: [{ name: "streamId", type: "bytes16" }],
    outputs: [],
  },
  {
    type: "event",
    name: "BroadcastAnnounced",
    anonymous: false,
    inputs: [
      { name: "streamId", type: "bytes16", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "session", type: "address", indexed: true },
      { name: "nonceStart", type: "uint64", indexed: false },
      { name: "expiresAt", type: "uint64", indexed: false },
      { name: "mediaMode", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BroadcastEnded",
    anonymous: false,
    inputs: [
      { name: "streamId", type: "bytes16", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
] as const;

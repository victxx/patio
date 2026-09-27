import { PATIO_DEFAULTS } from "@patio/config";
import {
  getAddress,
  isAddress,
  isHex,
  keccak256,
  stringToHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";

export interface BroadcastAuthorizationV1 {
  version: 1;
  operator: Address;
  sessionAddress: Address;
  streamId: Hex;
  chainId: number;
  expiresAt: bigint;
  nonceStart: bigint;
  nonceEnd: bigint;
  maxPayloadBytes: number;
  maxReplacementsPerWindow: number;
  maxFeePerGasWei: bigint;
  maxTotalExposureWei: bigint;
  relayOrigin: string;
}

export interface SerializedBroadcastAuthorizationV1 {
  version: 1;
  operator: Address;
  sessionAddress: Address;
  streamId: Hex;
  chainId: number;
  expiresAt: string;
  nonceStart: string;
  nonceEnd: string;
  maxPayloadBytes: number;
  maxReplacementsPerWindow: number;
  maxFeePerGasWei: string;
  maxTotalExposureWei: string;
  relayOrigin: string;
}

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "Invalid Ethereum address")
  .transform((value) => getAddress(value));

const decimalBigIntSchema = z
  .string()
  .regex(/^\d+$/, "Expected an unsigned decimal integer")
  .transform((value) => BigInt(value));

export const serializedBroadcastAuthorizationSchema = z.object({
  version: z.literal(1),
  operator: addressSchema,
  sessionAddress: addressSchema,
  streamId: z
    .string()
    .refine(
      (value): value is Hex =>
        isHex(value, { strict: true }) && value.length === 34,
      "streamId must be 16 bytes",
    ),
  chainId: z.number().int().positive(),
  expiresAt: decimalBigIntSchema,
  nonceStart: decimalBigIntSchema,
  nonceEnd: decimalBigIntSchema,
  maxPayloadBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024),
  maxReplacementsPerWindow: z.number().int().positive().max(20),
  maxFeePerGasWei: decimalBigIntSchema,
  maxTotalExposureWei: decimalBigIntSchema,
  relayOrigin: z.string().url().max(256),
});

export const broadcastAuthorizationTypes = {
  BroadcastAuthorization: [
    { name: "version", type: "uint8" },
    { name: "operator", type: "address" },
    { name: "sessionAddress", type: "address" },
    { name: "streamId", type: "bytes16" },
    { name: "chainId", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonceStart", type: "uint64" },
    { name: "nonceEnd", type: "uint64" },
    { name: "maxPayloadBytes", type: "uint32" },
    { name: "maxReplacementsPerWindow", type: "uint16" },
    { name: "maxFeePerGasWei", type: "uint256" },
    { name: "maxTotalExposureWei", type: "uint256" },
    { name: "relayOriginHash", type: "bytes32" },
  ],
} as const;

export function parseBroadcastAuthorization(
  input: unknown,
): BroadcastAuthorizationV1 {
  const parsed = serializedBroadcastAuthorizationSchema.parse(input);
  if (parsed.nonceEnd <= parsed.nonceStart) {
    throw new Error("nonceEnd must be greater than nonceStart");
  }
  if (
    parsed.nonceEnd - parsed.nonceStart >
    BigInt(PATIO_DEFAULTS.maxWindowsPerEpoch)
  ) {
    throw new Error("Authorization exceeds the nonce-window epoch limit");
  }
  if (
    parsed.maxFeePerGasWei <= 0n ||
    parsed.maxTotalExposureWei <= 0n ||
    parsed.maxTotalExposureWei > PATIO_DEFAULTS.maxSessionExposureWei
  ) {
    throw new Error("Authorization exceeds the global fee or exposure policy");
  }
  return parsed;
}

export function serializeBroadcastAuthorization(
  authorization: BroadcastAuthorizationV1,
): SerializedBroadcastAuthorizationV1 {
  return {
    ...authorization,
    expiresAt: authorization.expiresAt.toString(),
    nonceStart: authorization.nonceStart.toString(),
    nonceEnd: authorization.nonceEnd.toString(),
    maxFeePerGasWei: authorization.maxFeePerGasWei.toString(),
    maxTotalExposureWei: authorization.maxTotalExposureWei.toString(),
  };
}

export function broadcastAuthorizationTypedData(
  authorization: BroadcastAuthorizationV1,
) {
  return {
    domain: {
      name: "Patio Broadcast",
      version: "1",
      chainId: authorization.chainId,
    },
    types: broadcastAuthorizationTypes,
    primaryType: "BroadcastAuthorization" as const,
    message: {
      version: authorization.version,
      operator: authorization.operator,
      sessionAddress: authorization.sessionAddress,
      streamId: authorization.streamId,
      chainId: BigInt(authorization.chainId),
      expiresAt: authorization.expiresAt,
      nonceStart: authorization.nonceStart,
      nonceEnd: authorization.nonceEnd,
      maxPayloadBytes: authorization.maxPayloadBytes,
      maxReplacementsPerWindow: authorization.maxReplacementsPerWindow,
      maxFeePerGasWei: authorization.maxFeePerGasWei,
      maxTotalExposureWei: authorization.maxTotalExposureWei,
      relayOriginHash: keccak256(stringToHex(authorization.relayOrigin)),
    },
  };
}

export async function verifyBroadcastAuthorization(
  authorization: BroadcastAuthorizationV1,
  signature: Hex,
): Promise<boolean> {
  if (authorization.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
    return false;
  }
  return verifyTypedData({
    address: authorization.operator,
    signature,
    ...broadcastAuthorizationTypedData(authorization),
  });
}

export function sessionIdFor(authorization: BroadcastAuthorizationV1): Hex {
  return keccak256(
    stringToHex(
      [
        authorization.operator.toLowerCase(),
        authorization.sessionAddress.toLowerCase(),
        authorization.streamId,
        authorization.chainId,
        authorization.nonceStart,
      ].join(":"),
    ),
  );
}

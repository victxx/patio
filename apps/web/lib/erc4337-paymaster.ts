import {
  decodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  numberToHex,
  size,
  sliceHex,
  type Address,
  type Hex,
} from "viem";

import type { Erc4337UserOperationV07 } from "@patio/wallet-core";

export const VERIFYING_PAYMASTER_V07_PROFILE =
  "verifying-paymaster-v0.7.0" as const;

export interface PaymasterServiceTransport {
  request(input: {
    method: "pm_getPaymasterStubData" | "pm_getPaymasterData";
    params: readonly unknown[];
  }): Promise<unknown>;
}

export interface PaymasterSponsorshipConfig {
  chainId: number;
  entryPoint: Address;
  entryPointVersion: "0.7";
  paymaster: Address;
  paymasterCodeHash: Hex;
  profile: typeof VERIFYING_PAYMASTER_V07_PROFILE;
  sponsorId: string;
  sponsorLabel: string;
  endpointId: string;
  policyId: string;
  maximumResponseBytes: number;
  maximumPaymasterDataBytes: number;
  maximumPaymasterVerificationGas: bigint;
  maximumPaymasterPostOpGas: bigint;
  maximumSponsoredGasCostWei: bigint;
  minimumValiditySeconds: bigint;
}

export interface PaymasterFieldsV07 {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

export interface PaymasterStubDataV07 extends PaymasterFieldsV07 {
  isFinal: boolean;
}

export interface PaymasterFinalDataV07 extends PaymasterFieldsV07 {
  validUntil: bigint;
  validAfter: bigint;
}

export class PaymasterServiceError extends Error {
  public constructor(
    public readonly code:
      | "SERVICE_UNAVAILABLE"
      | "SPONSORSHIP_DECLINED"
      | "MALFORMED_RESPONSE"
      | "CONFIGURATION_MISMATCH"
      | "LIMIT_EXCEEDED"
      | "VALIDITY_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PaymasterServiceError";
  }
}

function safeMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "Paymaster service failed.")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-endpoint]")
    .replace(
      /(authorization|token|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .slice(0, 300);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function quantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !isHex(value, { strict: true })) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function unsignedRpcOperation(operation: Erc4337UserOperationV07) {
  return {
    sender: operation.sender,
    nonce: numberToHex(operation.nonce),
    callData: operation.callData,
    callGasLimit: numberToHex(operation.callGasLimit),
    verificationGasLimit: numberToHex(operation.verificationGasLimit),
    preVerificationGas: numberToHex(operation.preVerificationGas),
    maxFeePerGas: numberToHex(operation.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(operation.maxPriorityFeePerGas),
    ...(operation.paymaster
      ? {
          paymaster: operation.paymaster,
          paymasterData: operation.paymasterData ?? "0x",
          paymasterVerificationGasLimit: numberToHex(
            operation.paymasterVerificationGasLimit ?? 0n,
          ),
          paymasterPostOpGasLimit: numberToHex(
            operation.paymasterPostOpGasLimit ?? 0n,
          ),
        }
      : {}),
  } as const;
}

function parseFields(
  value: unknown,
  config: PaymasterSponsorshipConfig,
  requireGas: boolean,
): PaymasterFieldsV07 {
  const input = asRecord(value);
  const paymaster =
    typeof input?.paymaster === "string" && isAddress(input.paymaster)
      ? getAddress(input.paymaster)
      : null;
  const paymasterData =
    typeof input?.paymasterData === "string" &&
    isHex(input.paymasterData, { strict: true })
      ? input.paymasterData
      : null;
  const verification = quantity(input?.paymasterVerificationGasLimit);
  const postOp = quantity(input?.paymasterPostOpGasLimit);
  if (
    !paymaster ||
    !paymasterData ||
    (requireGas && (verification === null || postOp === null))
  ) {
    throw new PaymasterServiceError(
      "MALFORMED_RESPONSE",
      "Paymaster service returned incomplete EntryPoint v0.7 fields.",
    );
  }
  if (paymaster.toLowerCase() !== config.paymaster.toLowerCase()) {
    throw new PaymasterServiceError(
      "CONFIGURATION_MISMATCH",
      "Paymaster service returned an unapproved contract.",
    );
  }
  if (size(paymasterData) > config.maximumPaymasterDataBytes) {
    throw new PaymasterServiceError(
      "LIMIT_EXCEEDED",
      "Paymaster authorization data exceeds the configured limit.",
    );
  }
  const paymasterVerificationGasLimit = verification ?? 0n;
  const paymasterPostOpGasLimit = postOp ?? 0n;
  if (
    paymasterVerificationGasLimit > config.maximumPaymasterVerificationGas ||
    paymasterPostOpGasLimit > config.maximumPaymasterPostOpGas
  ) {
    throw new PaymasterServiceError(
      "LIMIT_EXCEEDED",
      "Paymaster gas requirements exceed the configured bounds.",
    );
  }
  return {
    paymaster,
    paymasterData,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
  };
}

function zeroByteCount(value: Hex): number {
  return (value.slice(2).match(/00/gu) ?? []).length;
}

export function assertFinalDataFitsStub(input: {
  stubData: Hex;
  finalData: Hex;
}): void {
  if (
    size(input.stubData) !== size(input.finalData) ||
    zeroByteCount(input.stubData) > zeroByteCount(input.finalData)
  ) {
    throw new PaymasterServiceError(
      "MALFORMED_RESPONSE",
      "Final paymaster data violates the reviewed preVerificationGas size assumptions.",
    );
  }
}

export function decodeVerifyingPaymasterValidity(paymasterData: Hex): {
  validUntil: bigint;
  validAfter: bigint;
} {
  if (size(paymasterData) < 128) {
    throw new PaymasterServiceError(
      "MALFORMED_RESPONSE",
      "VerifyingPaymaster data is too short for validity and signature fields.",
    );
  }
  try {
    const [validUntil, validAfter] = decodeAbiParameters(
      [{ type: "uint48" }, { type: "uint48" }],
      sliceHex(paymasterData, 0, 64),
    );
    return { validUntil: BigInt(validUntil), validAfter: BigInt(validAfter) };
  } catch {
    throw new PaymasterServiceError(
      "MALFORMED_RESPONSE",
      "VerifyingPaymaster validity data is malformed.",
    );
  }
}

export function assertSponsorshipValidity(input: {
  validAfter: bigint;
  validUntil: bigint;
  chainTimestamp: bigint;
  minimumValiditySeconds: bigint;
}): void {
  const effectiveUntil =
    input.validUntil === 0n ? (1n << 48n) - 1n : input.validUntil;
  if (input.chainTimestamp < input.validAfter) {
    throw new PaymasterServiceError(
      "VALIDITY_INVALID",
      "Sponsor authorization is not valid yet.",
    );
  }
  if (effectiveUntil <= input.chainTimestamp) {
    throw new PaymasterServiceError(
      "VALIDITY_INVALID",
      "Sponsor authorization expired.",
    );
  }
  if (effectiveUntil - input.chainTimestamp < input.minimumValiditySeconds) {
    throw new PaymasterServiceError(
      "VALIDITY_INVALID",
      "Sponsor authorization does not leave enough time for review.",
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  method: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${method} timed out.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class PatioPaymasterClient {
  public constructor(
    private readonly transport: PaymasterServiceTransport,
    public readonly config: PaymasterSponsorshipConfig,
    private readonly timeoutMs = 5_000,
  ) {
    if (
      !Number.isSafeInteger(config.chainId) ||
      !isAddress(config.entryPoint) ||
      !isAddress(config.paymaster) ||
      !isHex(config.paymasterCodeHash, { strict: true }) ||
      config.paymasterCodeHash.length !== 66 ||
      config.profile !== VERIFYING_PAYMASTER_V07_PROFILE ||
      config.sponsorId.trim().length === 0 ||
      config.endpointId.trim().length === 0 ||
      config.policyId.trim().length === 0 ||
      !Number.isSafeInteger(config.maximumResponseBytes) ||
      config.maximumResponseBytes <= 0 ||
      !Number.isSafeInteger(config.maximumPaymasterDataBytes) ||
      config.maximumPaymasterDataBytes <= 0 ||
      config.maximumPaymasterVerificationGas <= 0n ||
      config.maximumPaymasterVerificationGas >= 1n << 128n ||
      config.maximumPaymasterPostOpGas <= 0n ||
      config.maximumPaymasterPostOpGas >= 1n << 128n ||
      config.maximumSponsoredGasCostWei <= 0n ||
      config.minimumValiditySeconds < 0n
    ) {
      throw new PaymasterServiceError(
        "CONFIGURATION_MISMATCH",
        "Paymaster configuration is incomplete.",
      );
    }
  }

  public assertValidity(input: {
    validAfter: bigint;
    validUntil: bigint;
    chainTimestamp: bigint;
  }): void {
    assertSponsorshipValidity({
      ...input,
      minimumValiditySeconds: this.config.minimumValiditySeconds,
    });
  }

  private async call(
    method: "pm_getPaymasterStubData" | "pm_getPaymasterData",
    params: readonly unknown[],
  ) {
    let result: unknown;
    try {
      // Quotes can reserve quota or issue authorizations, so neither call retries.
      result = await withTimeout(
        this.transport.request({ method, params }),
        method,
        this.timeoutMs,
      );
    } catch (cause) {
      throw new PaymasterServiceError(
        "SERVICE_UNAVAILABLE",
        safeMessage(cause),
      );
    }
    let responseSize: number;
    try {
      responseSize = JSON.stringify(result).length;
    } catch {
      throw new PaymasterServiceError(
        "MALFORMED_RESPONSE",
        "Paymaster response is not valid JSON-RPC data.",
      );
    }
    if (responseSize > this.config.maximumResponseBytes) {
      throw new PaymasterServiceError(
        "LIMIT_EXCEEDED",
        "Paymaster response exceeds the configured size limit.",
      );
    }
    return result;
  }

  public async getStubData(
    operation: Erc4337UserOperationV07,
  ): Promise<PaymasterStubDataV07> {
    const result = await this.call("pm_getPaymasterStubData", [
      unsignedRpcOperation(operation),
      this.config.entryPoint,
      numberToHex(this.config.chainId),
      { policyId: this.config.policyId },
    ]);
    const fields = parseFields(result, this.config, true);
    return {
      ...fields,
      isFinal: asRecord(result)?.isFinal === true,
    };
  }

  public async getFinalData(input: {
    operation: Erc4337UserOperationV07;
    stub: PaymasterStubDataV07;
    chainTimestamp: bigint;
  }): Promise<PaymasterFinalDataV07> {
    const raw = input.stub.isFinal
      ? {
          paymaster: input.stub.paymaster,
          paymasterData: input.stub.paymasterData,
          paymasterVerificationGasLimit: numberToHex(
            input.stub.paymasterVerificationGasLimit,
          ),
          paymasterPostOpGasLimit: numberToHex(
            input.stub.paymasterPostOpGasLimit,
          ),
        }
      : await this.call("pm_getPaymasterData", [
          unsignedRpcOperation(input.operation),
          this.config.entryPoint,
          numberToHex(this.config.chainId),
          { policyId: this.config.policyId },
        ]);
    const parsed = parseFields(raw, this.config, input.stub.isFinal);
    const fields = {
      ...parsed,
      paymasterVerificationGasLimit: input.stub.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: input.stub.paymasterPostOpGasLimit,
    };
    assertFinalDataFitsStub({
      stubData: input.stub.paymasterData,
      finalData: fields.paymasterData,
    });
    const validity = decodeVerifyingPaymasterValidity(fields.paymasterData);
    assertSponsorshipValidity({
      ...validity,
      chainTimestamp: input.chainTimestamp,
      minimumValiditySeconds: this.config.minimumValiditySeconds,
    });
    return { ...fields, ...validity };
  }
}

export function paymasterCodeMatches(
  code: Hex,
  config: PaymasterSponsorshipConfig,
): boolean {
  return code !== "0x" && keccak256(code) === config.paymasterCodeHash;
}

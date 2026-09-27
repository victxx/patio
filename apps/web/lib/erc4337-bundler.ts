import {
  getAddress,
  isAddress,
  isHex,
  numberToHex,
  type Address,
  type Hex,
} from "viem";

import type { Erc4337UserOperationV07 } from "@patio/wallet-core";

export interface BundlerRpcTransport {
  request(input: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
}

export interface BundlerUserOperationGasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

export interface BundlerUserOperationLookup {
  userOperation: Erc4337UserOperationV07;
  entryPoint: Address;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
}

export interface BundlerUserOperationReceipt {
  userOpHash: Hex;
  entryPoint: Address;
  sender: Address;
  nonce: bigint;
  success: boolean;
  actualGasCostWei: bigint;
  actualGasUsed: bigint;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  outerStatus: "success" | "reverted";
}

export class BundlerRpcError extends Error {
  public constructor(
    public readonly method: string,
    message: string,
    public readonly uncertainSubmission = false,
  ) {
    super(message);
    this.name = "BundlerRpcError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hex(value: unknown): Hex | null {
  return typeof value === "string" && isHex(value, { strict: true })
    ? value
    : null;
}

function hash(value: unknown): Hex | null {
  const parsed = hex(value);
  return parsed && parsed.length === 66 ? parsed : null;
}

function address(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value)
    ? getAddress(value)
    : null;
}

function quantity(value: unknown): bigint | null {
  const parsed = hex(value);
  if (!parsed) return null;
  try {
    return BigInt(parsed);
  } catch {
    return null;
  }
}

function safeErrorMessage(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : "Bundler RPC failed.";
  return message
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-endpoint]")
    .replace(
      /(authorization|token|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .slice(0, 400);
}

function isDefiniteJsonRpcRejection(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const direct = cause as { code?: unknown; error?: { code?: unknown } };
  return (
    typeof direct.code === "number" || typeof direct.error?.code === "number"
  );
}

function rpcUserOperation(operation: Erc4337UserOperationV07) {
  return {
    sender: operation.sender,
    nonce: numberToHex(operation.nonce),
    callData: operation.callData,
    callGasLimit: numberToHex(operation.callGasLimit),
    verificationGasLimit: numberToHex(operation.verificationGasLimit),
    preVerificationGas: numberToHex(operation.preVerificationGas),
    maxFeePerGas: numberToHex(operation.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(operation.maxPriorityFeePerGas),
    signature: operation.signature,
    ...(operation.paymaster
      ? {
          paymaster: operation.paymaster,
          paymasterVerificationGasLimit: numberToHex(
            operation.paymasterVerificationGasLimit ?? 0n,
          ),
          paymasterPostOpGasLimit: numberToHex(
            operation.paymasterPostOpGasLimit ?? 0n,
          ),
          paymasterData: operation.paymasterData ?? "0x",
        }
      : {}),
  } as const;
}

function parseUserOperation(value: unknown): Erc4337UserOperationV07 | null {
  const input = record(value);
  if (!input) return null;
  const sender = address(input.sender);
  const nonce = quantity(input.nonce);
  const callData = hex(input.callData);
  const callGasLimit = quantity(input.callGasLimit);
  const verificationGasLimit = quantity(input.verificationGasLimit);
  const preVerificationGas = quantity(input.preVerificationGas);
  const maxFeePerGas = quantity(input.maxFeePerGas);
  const maxPriorityFeePerGas = quantity(input.maxPriorityFeePerGas);
  const signature = hex(input.signature);
  const paymaster =
    input.paymaster === undefined ? undefined : address(input.paymaster);
  const paymasterVerificationGasLimit =
    input.paymasterVerificationGasLimit === undefined
      ? undefined
      : quantity(input.paymasterVerificationGasLimit);
  const paymasterPostOpGasLimit =
    input.paymasterPostOpGasLimit === undefined
      ? undefined
      : quantity(input.paymasterPostOpGasLimit);
  const paymasterData =
    input.paymasterData === undefined ? undefined : hex(input.paymasterData);
  if (
    !sender ||
    nonce === null ||
    !callData ||
    callGasLimit === null ||
    verificationGasLimit === null ||
    preVerificationGas === null ||
    maxFeePerGas === null ||
    maxPriorityFeePerGas === null ||
    !signature ||
    (input.paymaster !== undefined && !paymaster) ||
    (input.paymasterVerificationGasLimit !== undefined &&
      paymasterVerificationGasLimit === null) ||
    (input.paymasterPostOpGasLimit !== undefined &&
      paymasterPostOpGasLimit === null) ||
    (input.paymasterData !== undefined && !paymasterData)
  ) {
    return null;
  }
  return {
    sender,
    nonce,
    callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature,
    ...(paymaster ? { paymaster } : {}),
    ...(paymasterVerificationGasLimit === undefined
      ? {}
      : { paymasterVerificationGasLimit: paymasterVerificationGasLimit! }),
    ...(paymasterPostOpGasLimit === undefined
      ? {}
      : { paymasterPostOpGasLimit: paymasterPostOpGasLimit! }),
    ...(paymasterData === undefined ? {} : { paymasterData: paymasterData! }),
  };
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

export class PatioBundlerClient {
  public constructor(
    private readonly transport: BundlerRpcTransport,
    private readonly options: {
      timeoutMs?: number;
      readRetries?: number;
    } = {},
  ) {}

  private async read(method: string, params: readonly unknown[] = []) {
    const attempts = Math.max(1, (this.options.readRetries ?? 1) + 1);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await withTimeout(
          this.transport.request({ method, params }),
          method,
          this.options.timeoutMs ?? 5_000,
        );
      } catch (cause) {
        lastError = cause;
      }
    }
    throw new BundlerRpcError(method, safeErrorMessage(lastError));
  }

  private async send(method: string, params: readonly unknown[]) {
    try {
      // Submission is intentionally attempted once. No transport fallback.
      return await withTimeout(
        this.transport.request({ method, params }),
        method,
        this.options.timeoutMs ?? 5_000,
      );
    } catch (cause) {
      throw new BundlerRpcError(
        method,
        safeErrorMessage(cause),
        !isDefiniteJsonRpcRejection(cause),
      );
    }
  }

  public async chainId(): Promise<number> {
    const parsed = quantity(await this.read("eth_chainId"));
    if (parsed === null || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BundlerRpcError(
        "eth_chainId",
        "Bundler returned an invalid chain ID.",
      );
    }
    return Number(parsed);
  }

  public async supportedEntryPoints(): Promise<readonly Address[]> {
    const result = await this.read("eth_supportedEntryPoints");
    if (!Array.isArray(result)) {
      throw new BundlerRpcError(
        "eth_supportedEntryPoints",
        "Bundler returned an invalid EntryPoint list.",
      );
    }
    const parsed = result.map(address);
    if (parsed.some((candidate) => candidate === null)) {
      throw new BundlerRpcError(
        "eth_supportedEntryPoints",
        "Bundler returned an invalid EntryPoint address.",
      );
    }
    return parsed as Address[];
  }

  public async estimateUserOperationGas(input: {
    operation: Erc4337UserOperationV07;
    entryPoint: Address;
  }): Promise<BundlerUserOperationGasEstimate> {
    const result = record(
      await this.read("eth_estimateUserOperationGas", [
        rpcUserOperation(input.operation),
        input.entryPoint,
      ]),
    );
    const callGasLimit = quantity(result?.callGasLimit);
    const verificationGasLimit = quantity(result?.verificationGasLimit);
    const preVerificationGas = quantity(result?.preVerificationGas);
    const paymasterVerificationGasLimit =
      result?.paymasterVerificationGasLimit === undefined
        ? undefined
        : quantity(result.paymasterVerificationGasLimit);
    const paymasterPostOpGasLimit =
      result?.paymasterPostOpGasLimit === undefined
        ? undefined
        : quantity(result.paymasterPostOpGasLimit);
    if (
      callGasLimit === null ||
      verificationGasLimit === null ||
      preVerificationGas === null ||
      paymasterVerificationGasLimit === null ||
      paymasterPostOpGasLimit === null
    ) {
      throw new BundlerRpcError(
        "eth_estimateUserOperationGas",
        "Bundler returned invalid UserOperation gas estimates.",
      );
    }
    return {
      callGasLimit,
      verificationGasLimit,
      preVerificationGas,
      ...(paymasterVerificationGasLimit === undefined
        ? {}
        : { paymasterVerificationGasLimit }),
      ...(paymasterPostOpGasLimit === undefined
        ? {}
        : { paymasterPostOpGasLimit }),
    };
  }

  public async sendUserOperation(input: {
    operation: Erc4337UserOperationV07;
    entryPoint: Address;
  }): Promise<Hex> {
    const result = hash(
      await this.send("eth_sendUserOperation", [
        rpcUserOperation(input.operation),
        input.entryPoint,
      ]),
    );
    if (!result) {
      throw new BundlerRpcError(
        "eth_sendUserOperation",
        "Bundler returned an invalid UserOperation hash.",
        true,
      );
    }
    return result;
  }

  public async getUserOperationByHash(
    userOpHash: Hex,
  ): Promise<BundlerUserOperationLookup | null> {
    const raw = await this.read("eth_getUserOperationByHash", [userOpHash]);
    if (raw === null) return null;
    const result = record(raw);
    const operation = parseUserOperation(result?.userOperation);
    const entryPoint = address(result?.entryPoint);
    const transactionHash = hash(result?.transactionHash);
    const blockHash = hash(result?.blockHash);
    const blockNumber = quantity(result?.blockNumber);
    if (
      !operation ||
      !entryPoint ||
      !transactionHash ||
      !blockHash ||
      blockNumber === null
    ) {
      throw new BundlerRpcError(
        "eth_getUserOperationByHash",
        "Bundler returned malformed UserOperation lookup data.",
      );
    }
    return {
      userOperation: operation,
      entryPoint,
      transactionHash,
      blockHash,
      blockNumber,
    };
  }

  public async getUserOperationReceipt(
    userOpHash: Hex,
  ): Promise<BundlerUserOperationReceipt | null> {
    const raw = await this.read("eth_getUserOperationReceipt", [userOpHash]);
    if (raw === null) return null;
    const result = record(raw);
    const outer = record(result?.receipt);
    const parsedHash = hash(result?.userOpHash);
    const entryPoint = address(result?.entryPoint);
    const sender = address(result?.sender);
    const nonce = quantity(result?.nonce);
    const actualGasCostWei = quantity(result?.actualGasCost);
    const actualGasUsed = quantity(result?.actualGasUsed);
    const transactionHash = hash(outer?.transactionHash);
    const blockHash = hash(outer?.blockHash);
    const blockNumber = quantity(outer?.blockNumber);
    const status = quantity(outer?.status);
    if (
      !parsedHash ||
      !entryPoint ||
      !sender ||
      nonce === null ||
      typeof result?.success !== "boolean" ||
      actualGasCostWei === null ||
      actualGasUsed === null ||
      !transactionHash ||
      !blockHash ||
      blockNumber === null ||
      (status !== 0n && status !== 1n)
    ) {
      throw new BundlerRpcError(
        "eth_getUserOperationReceipt",
        "Bundler returned malformed UserOperation receipt data.",
      );
    }
    return {
      userOpHash: parsedHash,
      entryPoint,
      sender,
      nonce,
      success: result.success,
      actualGasCostWei,
      actualGasUsed,
      transactionHash,
      blockHash,
      blockNumber,
      outerStatus: status === 1n ? "success" : "reverted",
    };
  }
}

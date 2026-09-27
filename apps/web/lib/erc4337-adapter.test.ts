import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import {
  ERC4337_ENTRY_POINT_V07,
  type OperationStorage,
} from "@patio/wallet-core";

import {
  createSimpleAccountV07Integration,
  loadErc4337Attempts,
  prepareErc4337Operation,
  prepareSponsoredErc4337Operation,
  signReviewedErc4337Operation,
  submitSignedErc4337Operation,
  userOperationHashV07,
  verifyErc4337Outcome,
  type Erc4337CanonicalReceipt,
  type Erc4337ChainReader,
} from "./erc4337-adapter";
import {
  PatioBundlerClient,
  type BundlerRpcTransport,
} from "./erc4337-bundler";
import {
  PatioPaymasterClient,
  type PaymasterSponsorshipConfig,
} from "./erc4337-paymaster";

const sender = getAddress("0x1111111111111111111111111111111111111111");
const target = getAddress("0x2222222222222222222222222222222222222222");
const paymaster = getAddress("0x3333333333333333333333333333333333333333");
const owner = privateKeyToAccount(`0x${"12".repeat(32)}`);
const outerHash: Hex = `0x${"bb".repeat(32)}`;
const blockHash: Hex = `0x${"cc".repeat(32)}`;
const eventAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

class MemoryStorage implements OperationStorage {
  private readonly values = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  public dump(): string {
    return [...this.values.values()].join("\n");
  }
}

function chain(
  overrides: Partial<Erc4337ChainReader> = {},
): Erc4337ChainReader {
  return {
    chainId: () => Promise.resolve(560_048),
    latestTimestamp: () => Promise.resolve(1_700_000_000n),
    code: () => Promise.resolve("0x60016000"),
    balance: () => Promise.resolve(5_000_000_000_000_000n),
    entryPointNonce: () => Promise.resolve(7n),
    entryPointDeposit: () => Promise.resolve(1_000_000_000_000_000n),
    receipt: () => Promise.resolve(null),
    ...overrides,
  };
}

function attemptLock() {
  return {
    runExclusive: <T>(_key: string, task: () => Promise<T>) => task(),
  };
}

function countRpcMethodCalls(
  calls: readonly (readonly unknown[])[],
  method: string,
): number {
  return calls.filter((call) => {
    const request = call[0];
    return (
      request !== null &&
      typeof request === "object" &&
      "method" in request &&
      request.method === method
    );
  }).length;
}

function bundlerTransport(
  input: {
    sendResult?: unknown;
    receipt?: unknown;
    failSend?: boolean;
  } = {},
): BundlerRpcTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(({ method }: { method: string }) => {
    if (method === "eth_chainId") return Promise.resolve("0x88bb0");
    if (method === "eth_supportedEntryPoints")
      return Promise.resolve([ERC4337_ENTRY_POINT_V07]);
    if (method === "eth_estimateUserOperationGas") {
      return Promise.resolve({
        callGasLimit: "0xc350",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0x61a8",
      });
    }
    if (method === "eth_sendUserOperation") {
      if (input.failSend) return Promise.reject(new Error("timeout"));
      return Promise.resolve(input.sendResult);
    }
    if (method === "eth_getUserOperationReceipt") {
      return Promise.resolve(input.receipt ?? null);
    }
    return Promise.reject(new Error(method));
  });
  return { request };
}

function integration(
  sign = vi.fn((input: { userOpHash: Hex }) =>
    owner.signMessage({ message: { raw: input.userOpHash } }),
  ),
) {
  return {
    account: createSimpleAccountV07Integration({
      sender,
      ownerContextId: `owner:${owner.address}`,
      signUserOperationHash: sign,
    }),
    sign,
  };
}

async function prepared(
  input: {
    transport?: ReturnType<typeof bundlerTransport>;
    chain?: Erc4337ChainReader;
    operationBudgetWei?: bigint;
  } = {},
) {
  const account = integration();
  const transport = input.transport ?? bundlerTransport();
  const bundler = new PatioBundlerClient(transport, { readRetries: 0 });
  const plan = await prepareErc4337Operation({
    attemptId: "attempt-1",
    chainId: 560_048,
    account: account.account,
    calls: [{ to: target, valueWei: 10n, data: "0x1234" }],
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    operationBudgetWei: input.operationBudgetWei ?? 5_000_000_000_000_000n,
    chain: input.chain ?? chain(),
    bundler,
    nowMs: 100,
  });
  return { ...account, plan, transport, bundler };
}

function fixtureHash(input: {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: number;
}): Hex {
  const accountGasLimits = concat([
    pad(toHex(input.verificationGasLimit), { size: 16 }),
    pad(toHex(input.callGasLimit), { size: 16 }),
  ]);
  const gasFees = concat([
    pad(toHex(input.maxPriorityFeePerGas), { size: 16 }),
    pad(toHex(input.maxFeePerGas), { size: 16 }),
  ]);
  const packedHash = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        input.sender,
        input.nonce,
        keccak256("0x"),
        keccak256(input.callData),
        accountGasLimits,
        input.preVerificationGas,
        gasFees,
        keccak256("0x"),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [packedHash, ERC4337_ENTRY_POINT_V07, BigInt(input.chainId)],
    ),
  );
}

function eventLog(input: {
  userOpHash: Hex;
  success: boolean;
  actualGasCostWei: bigint;
  actualGasUsed: bigint;
  paymaster?: Address;
}) {
  return {
    address: ERC4337_ENTRY_POINT_V07,
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: "UserOperationEvent",
      args: {
        userOpHash: input.userOpHash,
        sender,
        paymaster: input.paymaster ?? zeroAddress,
      },
    }) as readonly Hex[],
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [7n, input.success, input.actualGasCostWei, input.actualGasUsed],
    ),
    transactionHash: outerHash,
    blockHash,
    blockNumber: 10n,
  } as const;
}

function sponsorshipData(
  validUntil = 1_700_001_000n,
  validAfter = 1_699_999_000n,
): Hex {
  return concat([
    encodeAbiParameters(
      [{ type: "uint48" }, { type: "uint48" }],
      [Number(validUntil), Number(validAfter)],
    ),
    `0x${"11".repeat(65)}`,
  ]);
}

function paymasterClient() {
  const code = "0x60016000" as Hex;
  const config: PaymasterSponsorshipConfig = {
    chainId: 560_048,
    entryPoint: ERC4337_ENTRY_POINT_V07,
    entryPointVersion: "0.7",
    paymaster,
    paymasterCodeHash: keccak256(code),
    profile: "verifying-paymaster-v0.7.0",
    sponsorId: "fixture-sponsor",
    sponsorLabel: "Fixture sponsor",
    endpointId: "fixture-service",
    policyId: "ordinary-operations",
    maximumResponseBytes: 8_192,
    maximumPaymasterDataBytes: 256,
    maximumPaymasterVerificationGas: 200_000n,
    maximumPaymasterPostOpGas: 100_000n,
    maximumSponsoredGasCostWei: 5_000_000_000_000_000n,
    minimumValiditySeconds: 60n,
  };
  const request = vi.fn(({ method }: { method: string }) =>
    Promise.resolve(
      method === "pm_getPaymasterStubData"
        ? {
            paymaster,
            paymasterData: `0x${"ff".repeat(129)}`,
            paymasterVerificationGasLimit: "0x1d4c0",
            paymasterPostOpGasLimit: "0xea60",
            isFinal: false,
          }
        : { paymaster, paymasterData: sponsorshipData() },
    ),
  );
  return {
    client: new PatioPaymasterClient({ request }, config),
    request,
  };
}

function bundlerReceipt(userOpHash: Hex, success: boolean) {
  return {
    userOpHash,
    entryPoint: ERC4337_ENTRY_POINT_V07,
    sender,
    nonce: "0x7",
    success,
    actualGasCost: "0x64",
    actualGasUsed: "0x32",
    logs: [],
    receipt: {
      transactionHash: outerHash,
      blockHash,
      blockNumber: "0xa",
      status: "0x1",
    },
  };
}

describe("isolated ERC-4337 adapter", () => {
  it("prepares sponsorship before signing and keeps sponsor/user budgets separate", async () => {
    const { account, sign } = integration();
    const sponsor = paymasterClient();
    const bundler = new PatioBundlerClient(bundlerTransport(), {
      readRetries: 0,
    });
    const plan = await prepareSponsoredErc4337Operation({
      attemptId: "sponsored-1",
      chainId: 560_048,
      account,
      calls: [{ to: target, valueWei: 10n, data: "0x1234" }],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      operationBudgetWei: 10n,
      chain: chain(),
      bundler,
      paymaster: sponsor.client,
      nowMs: 100,
    });
    expect(sign).not.toHaveBeenCalled();
    expect(plan.gasPayment).toMatchObject({
      kind: "sponsored",
      paymaster,
      sponsorId: "fixture-sponsor",
    });
    expect(plan.maximumGasCostWei).toBe(710_000_000_000_000n);
    const signed = await signReviewedErc4337Operation({
      plan,
      account,
      chain: chain(),
      bundler,
      paymaster: sponsor.client,
      explicitApproval: true,
      nowMs: 101,
    });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(signed.operation).toMatchObject({
      paymaster,
      paymasterVerificationGasLimit: 120_000n,
      paymasterPostOpGasLimit: 60_000n,
    });
  });

  it("never falls back to self-pay when sponsorship is invalid or depleted", async () => {
    const { account } = integration();
    const sponsor = paymasterClient();
    const bundler = new PatioBundlerClient(bundlerTransport(), {
      readRetries: 0,
    });
    await expect(
      prepareSponsoredErc4337Operation({
        attemptId: "sponsored-empty",
        chainId: 560_048,
        account,
        calls: [{ to: target, valueWei: 0n, data: "0x" }],
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        chain: chain({ entryPointDeposit: () => Promise.resolve(0n) }),
        bundler,
        paymaster: sponsor.client,
      }),
    ).rejects.toMatchObject({ code: "PAYMASTER_DEPOSIT_INSUFFICIENT" });
  });

  it("shares one nonce lock and unresolved-attempt guard across payment modes", async () => {
    const transport = bundlerTransport();
    const bundler = new PatioBundlerClient(transport, { readRetries: 0 });
    const { account } = integration();
    const sponsor = paymasterClient();
    const selfPlan = await prepareErc4337Operation({
      attemptId: "self-attempt",
      chainId: 560_048,
      account,
      calls: [{ to: target, valueWei: 0n, data: "0x" }],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      chain: chain(),
      bundler,
      nowMs: 100,
    });
    const sponsoredPlan = await prepareSponsoredErc4337Operation({
      attemptId: "sponsored-attempt",
      chainId: 560_048,
      account,
      calls: [{ to: target, valueWei: 0n, data: "0x" }],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      chain: chain(),
      bundler,
      paymaster: sponsor.client,
      nowMs: 100,
    });
    const selfSigned = await signReviewedErc4337Operation({
      plan: selfPlan,
      account,
      chain: chain(),
      bundler,
      explicitApproval: true,
      nowMs: 101,
    });
    const sponsoredSigned = await signReviewedErc4337Operation({
      plan: sponsoredPlan,
      account,
      chain: chain(),
      bundler,
      paymaster: sponsor.client,
      explicitApproval: true,
      nowMs: 101,
    });
    transport.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_chainId") return Promise.resolve("0x88bb0");
      if (method === "eth_supportedEntryPoints")
        return Promise.resolve([ERC4337_ENTRY_POINT_V07]);
      if (method === "eth_sendUserOperation")
        return Promise.resolve(selfSigned.expectedUserOpHash);
      return Promise.reject(new Error(method));
    });
    const storage = new MemoryStorage();
    await submitSignedErc4337Operation({
      signed: selfSigned,
      account,
      chain: chain(),
      bundler,
      storage,
      lock: attemptLock(),
      explicitApproval: true,
      nowMs: 102,
    });
    await expect(
      submitSignedErc4337Operation({
        signed: sponsoredSigned,
        account,
        chain: chain(),
        bundler,
        paymaster: sponsor.client,
        storage,
        lock: attemptLock(),
        explicitApproval: true,
        nowMs: 103,
      }),
    ).rejects.toThrow("unresolved Patio attempt");
    expect(
      countRpcMethodCalls(
        transport.request.mock.calls,
        "eth_sendUserOperation",
      ),
    ).toBe(1);
  });
  it("requires an explicit account integration and rejects protected/deployment/paymaster/7702 inputs", async () => {
    const bundler = new PatioBundlerClient(bundlerTransport(), {
      readRetries: 0,
    });
    const base = {
      attemptId: "x",
      chainId: 560_048,
      calls: [{ to: target, valueWei: 0n, data: "0x" as Hex }],
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      chain: chain(),
      bundler,
    };
    await expect(prepareErc4337Operation(base)).rejects.toMatchObject({
      code: "ACCOUNT_ADAPTER_REQUIRED",
    });
    const account = integration().account;
    await expect(
      prepareErc4337Operation({
        ...base,
        account,
        protectedPatioOperation: true,
      }),
    ).rejects.toMatchObject({ code: "PROTECTED_PATIO_OPERATION" });
    await expect(
      prepareErc4337Operation({ ...base, account, factory: target }),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_SUPPORTED" });
    await expect(
      prepareErc4337Operation({ ...base, account, paymaster: target }),
    ).rejects.toMatchObject({ code: "PAYMASTER_NOT_SUPPORTED" });
    await expect(
      prepareErc4337Operation({ ...base, account, authorization: {} }),
    ).rejects.toMatchObject({ code: "EIP7702_NOT_SUPPORTED" });
  });

  it("encodes SimpleAccount v0.7 calls and reads nonce from EntryPoint without signing", async () => {
    const nonce = vi.fn(() => Promise.resolve(7n));
    const { plan, sign } = await prepared({
      chain: chain({ entryPointNonce: nonce }),
    });
    expect(plan.accountImplementation).toBe("simple-account-v0.7.0");
    expect(plan.callData).toMatch(/^0xb61d27f6/);
    expect(plan.nonce).toBe(7n);
    expect(nonce).toHaveBeenCalledWith({
      entryPoint: ERC4337_ENTRY_POINT_V07,
      sender,
      key: 0n,
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it("rejects wrong chain, unavailable EntryPoint and undeployed account", async () => {
    const account = integration().account;
    const base = {
      attemptId: "binding",
      chainId: 560_048,
      account,
      calls: [{ to: target, valueWei: 0n, data: "0x" as Hex }],
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    };
    await expect(
      prepareErc4337Operation({
        ...base,
        chain: chain({ chainId: () => Promise.resolve(1) }),
        bundler: new PatioBundlerClient(bundlerTransport(), {
          readRetries: 0,
        }),
      }),
    ).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    const unsupported = bundlerTransport();
    unsupported.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_chainId") return Promise.resolve("0x88bb0");
      if (method === "eth_supportedEntryPoints")
        return Promise.resolve([target]);
      return Promise.reject(new Error(method));
    });
    await expect(
      prepareErc4337Operation({
        ...base,
        chain: chain(),
        bundler: new PatioBundlerClient(unsupported, { readRetries: 0 }),
      }),
    ).rejects.toMatchObject({ code: "WRONG_ENTRY_POINT" });
    await expect(
      prepareErc4337Operation({
        ...base,
        chain: chain({
          code: (address) =>
            Promise.resolve(
              address.toLowerCase() === sender.toLowerCase()
                ? "0x"
                : "0x60016000",
            ),
        }),
        bundler: new PatioBundlerClient(bundlerTransport(), {
          readRetries: 0,
        }),
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_DEPLOYED" });
  });

  it("blocks insufficient prefund and an independent ordinary-operation budget", async () => {
    await expect(
      prepared({
        chain: chain({
          balance: () => Promise.resolve(0n),
          entryPointDeposit: () => Promise.resolve(0n),
        }),
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PREFUND" });
    await expect(prepared({ operationBudgetWei: 1n })).rejects.toMatchObject({
      code: "OPERATION_BUDGET_EXCEEDED",
    });
  });

  it("cross-checks the v0.7 UserOperation hash against the pinned EntryPoint formula", async () => {
    const { plan, account, bundler } = await prepared();
    const signed = await signReviewedErc4337Operation({
      plan,
      account,
      chain: chain(),
      bundler,
      explicitApproval: true,
      nowMs: 101,
    });
    expect(signed.expectedUserOpHash).toBe(
      fixtureHash({
        ...signed.operation,
        chainId: plan.chainId,
      }),
    );
    expect(signed.expectedUserOpHash).toBe(
      "0xc4b517a7c2d0aee513b1f2ec98268eefda7d3edaf89b95e417ca7ee62d6b8218",
    );
    expect(
      userOperationHashV07({
        operation: signed.operation,
        chainId: plan.chainId,
      }),
    ).toBe(signed.expectedUserOpHash);
  });

  it("invalidates a reviewed operation when nonce or owner context changes", async () => {
    const { plan, bundler } = await prepared();
    await expect(
      signReviewedErc4337Operation({
        plan,
        account: integration().account,
        chain: chain({ entryPointNonce: () => Promise.resolve(8n) }),
        bundler,
        explicitApproval: true,
        nowMs: 101,
      }),
    ).rejects.toThrow("nonce changed");
    const differentOwner = createSimpleAccountV07Integration({
      sender,
      ownerContextId: "another-owner",
      signUserOperationHash: () => Promise.resolve<Hex>(`0x${"11".repeat(65)}`),
    });
    await expect(
      signReviewedErc4337Operation({
        plan,
        account: differentOwner,
        chain: chain(),
        bundler,
        explicitApproval: true,
        nowMs: 101,
      }),
    ).rejects.toThrow("context changed");
  });

  it("one approved attempt sends once and persists metadata only", async () => {
    const transport = bundlerTransport();
    const { plan, account, bundler } = await prepared({ transport });
    const signed = await signReviewedErc4337Operation({
      plan,
      account,
      chain: chain(),
      bundler,
      explicitApproval: true,
      nowMs: 101,
    });
    transport.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_chainId") return Promise.resolve("0x88bb0");
      if (method === "eth_supportedEntryPoints")
        return Promise.resolve([ERC4337_ENTRY_POINT_V07]);
      if (method === "eth_sendUserOperation")
        return Promise.resolve(signed.expectedUserOpHash);
      return Promise.reject(new Error(method));
    });
    const storage = new MemoryStorage();
    const result = await submitSignedErc4337Operation({
      signed,
      account,
      chain: chain(),
      bundler,
      storage,
      lock: attemptLock(),
      explicitApproval: true,
      nowMs: 102,
    });
    expect(result.kind).toBe("submitted");
    expect(
      countRpcMethodCalls(
        transport.request.mock.calls,
        "eth_sendUserOperation",
      ),
    ).toBe(1);
    expect(storage.dump()).not.toMatch(/callData|signature|0x1234|private/i);
    expect(loadErc4337Attempts(storage)[0]?.state).toBe("submitted");
    await expect(
      submitSignedErc4337Operation({
        signed,
        account,
        chain: chain(),
        bundler,
        storage,
        lock: attemptLock(),
        explicitApproval: true,
        nowMs: 103,
      }),
    ).rejects.toThrow("unresolved Patio attempt");
    expect(
      countRpcMethodCalls(
        transport.request.mock.calls,
        "eth_sendUserOperation",
      ),
    ).toBe(1);
  });

  it("retains uncertainty after timeout or a returned-hash mismatch without retry", async () => {
    for (const mode of ["timeout", "mismatch"] as const) {
      const transport = bundlerTransport();
      const { plan, account, bundler } = await prepared({ transport });
      const signed = await signReviewedErc4337Operation({
        plan,
        account,
        chain: chain(),
        bundler,
        explicitApproval: true,
        nowMs: 101,
      });
      transport.request.mockImplementation(({ method }: { method: string }) => {
        if (method === "eth_chainId") return Promise.resolve("0x88bb0");
        if (method === "eth_supportedEntryPoints")
          return Promise.resolve([ERC4337_ENTRY_POINT_V07]);
        if (method === "eth_sendUserOperation") {
          return mode === "timeout"
            ? Promise.reject(new Error("timeout"))
            : Promise.resolve(`0x${"ff".repeat(32)}`);
        }
        return Promise.reject(new Error(method));
      });
      const result = await submitSignedErc4337Operation({
        signed,
        account,
        chain: chain(),
        bundler,
        storage: new MemoryStorage(),
        lock: attemptLock(),
        explicitApproval: true,
        nowMs: 102,
      });
      expect(result.kind).toBe("uncertain");
      expect(
        countRpcMethodCalls(
          transport.request.mock.calls,
          "eth_sendUserOperation",
        ),
      ).toBe(1);
    }
  });

  it("records a definite bundler JSON-RPC rejection before acceptance", async () => {
    const transport = bundlerTransport();
    const { plan, account, bundler } = await prepared({ transport });
    const signed = await signReviewedErc4337Operation({
      plan,
      account,
      chain: chain(),
      bundler,
      explicitApproval: true,
      nowMs: 101,
    });
    transport.request.mockImplementation(({ method }: { method: string }) => {
      if (method === "eth_chainId") return Promise.resolve("0x88bb0");
      if (method === "eth_supportedEntryPoints")
        return Promise.resolve([ERC4337_ENTRY_POINT_V07]);
      if (method === "eth_sendUserOperation") {
        return Promise.reject(
          Object.assign(new Error("AA21 prefund too low"), { code: -32_500 }),
        );
      }
      return Promise.reject(new Error(method));
    });
    const result = await submitSignedErc4337Operation({
      signed,
      account,
      chain: chain(),
      bundler,
      storage: new MemoryStorage(),
      lock: attemptLock(),
      explicitApproval: true,
      nowMs: 102,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      record: { state: "rejected" },
    });
  });

  it("requires a matching canonical EntryPoint event and preserves per-operation revert", async () => {
    const { plan, account, bundler: prepareBundler } = await prepared();
    const signed = await signReviewedErc4337Operation({
      plan,
      account,
      chain: chain(),
      bundler: prepareBundler,
      explicitApproval: true,
      nowMs: 101,
    });
    const otherHash: Hex = `0x${"dd".repeat(32)}`;
    const transport = bundlerTransport({
      receipt: bundlerReceipt(signed.expectedUserOpHash, false),
    });
    const bundler = new PatioBundlerClient(transport, { readRetries: 0 });
    const canonical: Erc4337CanonicalReceipt = {
      transactionHash: outerHash,
      blockHash,
      blockNumber: 10n,
      status: "success",
      logs: [
        eventLog({
          userOpHash: otherHash,
          success: true,
          actualGasCostWei: 999n,
          actualGasUsed: 888n,
        }),
        eventLog({
          userOpHash: signed.expectedUserOpHash,
          success: false,
          actualGasCostWei: 100n,
          actualGasUsed: 50n,
        }),
      ],
    };
    const outcome = await verifyErc4337Outcome({
      attempt: {
        attemptId: "attempt-1",
        chainId: 560_048,
        entryPoint: ERC4337_ENTRY_POINT_V07,
        sender,
        nonce: 7n,
        expectedUserOpHash: signed.expectedUserOpHash,
        gasPayment: { kind: "self-paid" },
        state: "submitted",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      chain: chain({ receipt: () => Promise.resolve(canonical) }),
      bundler,
      nowMs: 200,
    });
    expect(outcome).toMatchObject({
      kind: "included",
      success: false,
      operation: {
        operationState: "included-reverted",
        executionResult: "reverted",
        actualGasCostWei: 100n,
        outerTransactionHash: outerHash,
      },
    });
  });

  it("identifies a sponsor only from the matching canonical paymaster event", async () => {
    const userOpHash: Hex = `0x${"ab".repeat(32)}`;
    const bundler = new PatioBundlerClient(
      bundlerTransport({ receipt: bundlerReceipt(userOpHash, false) }),
      { readRetries: 0 },
    );
    const attempt = {
      attemptId: "sponsored-outcome",
      chainId: 560_048,
      entryPoint: ERC4337_ENTRY_POINT_V07,
      sender,
      nonce: 7n,
      expectedUserOpHash: userOpHash,
      gasPayment: {
        kind: "sponsored" as const,
        sponsorId: "fixture-sponsor",
        paymaster,
        profile: "verifying-paymaster-v0.7.0" as const,
        status: "offered" as const,
      },
      state: "submitted" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const receipt: Erc4337CanonicalReceipt = {
      transactionHash: outerHash,
      blockHash,
      blockNumber: 10n,
      status: "success",
      logs: [
        eventLog({
          userOpHash,
          success: false,
          actualGasCostWei: 100n,
          actualGasUsed: 50n,
          paymaster,
        }),
      ],
    };
    const outcome = await verifyErc4337Outcome({
      attempt,
      chain: chain({ receipt: () => Promise.resolve(receipt) }),
      bundler,
    });
    expect(outcome).toMatchObject({
      kind: "included",
      success: false,
      operation: {
        executionResult: "reverted",
        actualGasCostWei: 100n,
        gasPayment: { kind: "sponsored", status: "verified", paymaster },
      },
    });
    const mismatch = await verifyErc4337Outcome({
      attempt: {
        ...attempt,
        gasPayment: { ...attempt.gasPayment, paymaster: target },
      },
      chain: chain({ receipt: () => Promise.resolve(receipt) }),
      bundler,
    });
    expect(mismatch).toMatchObject({ kind: "inconsistent" });
  });

  it("treats missing or reorganized canonical evidence as unknown, never dropped", async () => {
    const userOpHash: Hex = `0x${"aa".repeat(32)}`;
    const reorganizedBlockHash: Hex = `0x${"ee".repeat(32)}`;
    const bundler = new PatioBundlerClient(
      bundlerTransport({ receipt: bundlerReceipt(userOpHash, true) }),
      { readRetries: 0 },
    );
    const attempt = {
      attemptId: "attempt-1",
      chainId: 560_048,
      entryPoint: ERC4337_ENTRY_POINT_V07,
      sender,
      nonce: 7n,
      expectedUserOpHash: userOpHash,
      gasPayment: { kind: "self-paid" } as const,
      state: "submitted" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    expect(
      await verifyErc4337Outcome({ attempt, chain: chain(), bundler }),
    ).toMatchObject({ kind: "unknown" });
    expect(
      await verifyErc4337Outcome({
        attempt,
        bundler,
        chain: chain({
          receipt: () =>
            Promise.resolve({
              transactionHash: outerHash,
              blockHash: reorganizedBlockHash,
              blockNumber: 10n,
              status: "success",
              logs: [],
            }),
        }),
      }),
    ).toMatchObject({ kind: "unknown" });
  });
});

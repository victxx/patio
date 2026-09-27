import { readFileSync } from "node:fs";

import ganache from "ganache";
import solc from "solc";
import {
  concat,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import {
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Erc4337UserOperationV07 } from "@patio/wallet-core";

interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

interface GanacheAccount {
  secretKey: Hex;
}

type LocalOperation = Erc4337UserOperationV07;

function pack(operation: LocalOperation) {
  return toPackedUserOperation(operation);
}

const userOperationEventAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

function artifact(name: string): Artifact {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../node_modules/@account-abstraction/contracts/artifacts/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Artifact;
}

function compileFixture(fileName: string, contractName: string): Artifact {
  const source = readFileSync(
    new URL(`../test-fixtures/${fileName}`, import.meta.url),
    "utf8",
  );
  const compiler = solc as unknown as { compile(input: string): string };
  const output = JSON.parse(
    compiler.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [fileName]: { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: {
            "*": { "*": ["abi", "evm.bytecode.object"] },
          },
        },
      }),
    ),
  ) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts?: Record<
      string,
      Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>
    >;
  };
  const fatal = output.errors?.filter((error) => error.severity === "error");
  if (fatal?.length)
    throw new Error(fatal.map((error) => error.formattedMessage).join("\n"));
  const contract = output.contracts?.[fileName]?.[contractName];
  if (!contract) throw new Error("Local target fixture did not compile.");
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

describe.sequential("EntryPoint v0.7 local EVM interoperability", () => {
  const chain = defineChain({
    id: 31_337,
    name: "Patio local EntryPoint fixture",
    nativeCurrency: { name: "Test Ether", symbol: "TETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1"] } },
  });
  const provider = ganache.provider({
    chain: { chainId: chain.id, hardfork: "shanghai" },
    logging: { quiet: true },
    wallet: { deterministic: true, totalAccounts: 6 },
  });
  const transport = custom(provider as unknown as EIP1193Provider);
  const publicClient = createPublicClient({ chain, transport });
  const localAccounts = Object.values(
    provider.getInitialAccounts() as Record<string, GanacheAccount>,
  );
  const bundler = privateKeyToAccount(localAccounts[0]!.secretKey);
  const owner = privateKeyToAccount(localAccounts[1]!.secretKey);
  const sponsor = privateKeyToAccount(localAccounts[2]!.secretKey);
  const wallet = createWalletClient({ account: bundler, chain, transport });
  const entryPointArtifact = artifact("EntryPoint");
  const factoryArtifact = artifact("SimpleAccountFactory");
  const paymasterArtifact = artifact("VerifyingPaymaster");
  const targetArtifact = compileFixture("Erc4337Target.sol", "Erc4337Target");
  const revertingPaymasterArtifact = compileFixture(
    "PostOpRevertingPaymaster.sol",
    "PostOpRevertingPaymaster",
  );
  let entryPoint: Address;
  let factory: Address;
  let account: Address;
  let paymaster: Address;
  let emptyPaymaster: Address;
  let revertingPaymaster: Address;
  let target: Address;

  async function deploy(input: {
    artifact: Artifact;
    args?: readonly unknown[];
  }): Promise<Address> {
    const hash = await wallet.deployContract({
      abi: input.artifact.abi,
      bytecode: input.artifact.bytecode,
      args: input.args ?? [],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Fixture deployment failed.");
    return getAddress(receipt.contractAddress);
  }

  async function write(input: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
    gas?: bigint;
  }) {
    const hash = await wallet.writeContract({
      address: input.address,
      abi: input.abi,
      functionName: input.functionName,
      args: input.args ?? [],
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.gas === undefined ? {} : { gas: input.gas }),
    });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  function baseOperation(callData: Hex, nonce: bigint): LocalOperation {
    return {
      sender: account,
      nonce,
      callData,
      callGasLimit: 350_000n,
      verificationGasLimit: 350_000n,
      preVerificationGas: 80_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      signature: "0x",
    };
  }

  async function ownerSign(operation: LocalOperation): Promise<LocalOperation> {
    const hash = getUserOperationHash({
      userOperation: operation,
      entryPointAddress: entryPoint,
      entryPointVersion: "0.7",
      chainId: chain.id,
    });
    return {
      ...operation,
      signature: await owner.signMessage({ message: { raw: hash } }),
    };
  }

  async function sponsorOperation(input: {
    operation: LocalOperation;
    contract?: Address;
    signer?: PrivateKeyAccount;
    validUntil?: bigint;
    validAfter?: bigint;
    verificationGas?: bigint;
    postOpGas?: bigint;
  }): Promise<LocalOperation> {
    const contract = input.contract ?? paymaster;
    const validUntil = input.validUntil ?? 0n;
    const validAfter = input.validAfter ?? 0n;
    const provisional: LocalOperation = {
      ...input.operation,
      paymaster: contract,
      paymasterVerificationGasLimit: input.verificationGas ?? 250_000n,
      paymasterPostOpGasLimit: input.postOpGas ?? 100_000n,
      paymasterData: "0x",
    };
    const sponsorHash = await publicClient.readContract({
      address: contract,
      abi: paymasterArtifact.abi,
      functionName: "getHash",
      args: [pack(provisional), Number(validUntil), Number(validAfter)],
    });
    const signature = await (input.signer ?? sponsor).signMessage({
      message: { raw: sponsorHash as Hex },
    });
    return {
      ...provisional,
      paymasterData: concat([
        encodeAbiParameters(
          [{ type: "uint48" }, { type: "uint48" }],
          [Number(validUntil), Number(validAfter)],
        ),
        signature,
      ]),
    };
  }

  async function execute(operation: LocalOperation) {
    const expectedHash = getUserOperationHash({
      userOperation: operation,
      entryPointAddress: entryPoint,
      entryPointVersion: "0.7",
      chainId: chain.id,
    });
    const receipt = await write({
      address: entryPoint,
      abi: entryPointArtifact.abi,
      functionName: "handleOps",
      args: [[pack(operation)], bundler.address],
      gas: 8_000_000n,
    });
    const event = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({
            abi: userOperationEventAbi,
            eventName: "UserOperationEvent",
            topics: log.topics,
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find(
        (log) =>
          log?.args.userOpHash.toLowerCase() === expectedHash.toLowerCase(),
      );
    return { receipt, event, expectedHash };
  }

  function accountCall(functionName: "setValue" | "fail", value?: bigint) {
    const targetData = encodeFunctionData({
      abi: targetArtifact.abi,
      functionName,
      args: functionName === "setValue" ? [value ?? 0n] : [],
    });
    return encodeFunctionData({
      abi: parseAbi([
        "function execute(address dest,uint256 value,bytes func)",
      ]),
      functionName: "execute",
      args: [target, 0n, targetData],
    });
  }

  beforeAll(async () => {
    entryPoint = await deploy({ artifact: entryPointArtifact });
    factory = await deploy({ artifact: factoryArtifact, args: [entryPoint] });
    target = await deploy({ artifact: targetArtifact });
    paymaster = await deploy({
      artifact: paymasterArtifact,
      args: [entryPoint, sponsor.address],
    });
    emptyPaymaster = await deploy({
      artifact: paymasterArtifact,
      args: [entryPoint, sponsor.address],
    });
    revertingPaymaster = await deploy({
      artifact: revertingPaymasterArtifact,
      args: [entryPoint],
    });
    account = getAddress(
      (await publicClient.readContract({
        address: factory,
        abi: factoryArtifact.abi,
        functionName: "getAddress",
        args: [owner.address, 0n],
      })) as Address,
    );
    await write({
      address: factory,
      abi: factoryArtifact.abi,
      functionName: "createAccount",
      args: [owner.address, 0n],
    });
    await wallet.sendTransaction({
      to: account,
      value: 2_000_000_000_000_000n,
    });
    await write({
      address: entryPoint,
      abi: entryPointArtifact.abi,
      functionName: "depositTo",
      args: [paymaster],
      value: 20_000_000_000_000_000n,
    });
    await write({
      address: entryPoint,
      abi: entryPointArtifact.abi,
      functionName: "depositTo",
      args: [revertingPaymaster],
      value: 5_000_000_000_000_000n,
    });
  }, 60_000);

  afterAll(async () => {
    await provider.disconnect();
  });

  it("executes self-paid and sponsored operations through the real EntryPoint", async () => {
    const selfPaid = await ownerSign(
      baseOperation(accountCall("setValue", 11n), 0n),
    );
    const selfResult = await execute(selfPaid);
    expect(selfResult.receipt.status).toBe("success");
    expect(selfResult.event?.args).toMatchObject({
      sender: account,
      paymaster: "0x0000000000000000000000000000000000000000",
      success: true,
    });

    const balanceBefore = await publicClient.getBalance({ address: account });
    const sponsored = await ownerSign(
      await sponsorOperation({
        operation: baseOperation(accountCall("setValue", 22n), 1n),
      }),
    );
    const sponsoredResult = await execute(sponsored);
    expect(sponsoredResult.receipt.status).toBe("success");
    expect(sponsoredResult.event?.args).toMatchObject({
      sender: account,
      paymaster,
      success: true,
    });
    expect(await publicClient.getBalance({ address: account })).toBe(
      balanceBefore,
    );
    expect(
      await publicClient.readContract({
        address: target,
        abi: targetArtifact.abi,
        functionName: "value",
      }),
    ).toBe(22n);
  }, 60_000);

  it("rejects invalid/expired sponsorship and insufficient paymaster deposit", async () => {
    const nonce = 2n;
    const invalid = await ownerSign(
      await sponsorOperation({
        operation: baseOperation(accountCall("setValue", 30n), nonce),
        signer: owner,
      }),
    );
    expect((await execute(invalid)).receipt.status).toBe("reverted");

    const latest = await publicClient.getBlock();
    const expired = await ownerSign(
      await sponsorOperation({
        operation: baseOperation(accountCall("setValue", 31n), nonce),
        validUntil: latest.timestamp - 1n,
      }),
    );
    expect((await execute(expired)).receipt.status).toBe("reverted");

    const noDeposit = await ownerSign(
      await sponsorOperation({
        operation: baseOperation(accountCall("setValue", 32n), nonce),
        contract: emptyPaymaster,
      }),
    );
    expect((await execute(noDeposit)).receipt.status).toBe("reverted");
    expect(
      await publicClient.readContract({
        address: entryPoint,
        abi: entryPointArtifact.abi,
        functionName: "getNonce",
        args: [account, 0n],
      }),
    ).toBe(nonce);
  }, 60_000);

  it("records target revert as failed execution while charging the paymaster", async () => {
    const depositBefore = (await publicClient.readContract({
      address: entryPoint,
      abi: entryPointArtifact.abi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;
    const operation = await ownerSign(
      await sponsorOperation({
        operation: baseOperation(accountCall("fail"), 2n),
      }),
    );
    const result = await execute(operation);
    expect(result.receipt.status).toBe("success");
    expect(result.event?.args).toMatchObject({ paymaster, success: false });
    const depositAfter = (await publicClient.readContract({
      address: entryPoint,
      abi: entryPointArtifact.abi,
      functionName: "balanceOf",
      args: [paymaster],
    })) as bigint;
    expect(depositAfter).toBeLessThan(depositBefore);
  }, 60_000);

  it("rejects an operation whose finalized sponsorship changed after account signing", async () => {
    const reviewed = await ownerSign(
      await sponsorOperation({
        operation: baseOperation(accountCall("setValue", 40n), 3n),
      }),
    );
    const changedSponsorFields = await sponsorOperation({
      operation: {
        ...reviewed,
        paymasterVerificationGasLimit: 260_000n,
        signature: "0x",
      },
      verificationGas: 260_000n,
    });
    const mutated = { ...changedSponsorFields, signature: reviewed.signature };
    expect((await execute(mutated)).receipt.status).toBe("reverted");
  }, 60_000);

  it("executes the local negative postOp path without attributing success", async () => {
    const operation = await ownerSign({
      ...baseOperation(accountCall("setValue", 50n), 3n),
      paymaster: revertingPaymaster,
      paymasterVerificationGasLimit: 250_000n,
      paymasterPostOpGasLimit: 100_000n,
      paymasterData: "0x",
    });
    const result = await execute(operation);
    expect(result.receipt.status).toBe("reverted");
    expect(result.event).toBeUndefined();
    expect(
      await publicClient.readContract({
        address: entryPoint,
        abi: entryPointArtifact.abi,
        functionName: "getNonce",
        args: [account, 0n],
      }),
    ).toBe(3n);
  }, 60_000);
});

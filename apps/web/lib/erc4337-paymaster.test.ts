import {
  concat,
  encodeAbiParameters,
  getAddress,
  keccak256,
  numberToHex,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  ERC4337_ENTRY_POINT_V07,
  type Erc4337UserOperationV07,
} from "@patio/wallet-core";

import {
  PatioPaymasterClient,
  PaymasterServiceError,
  assertFinalDataFitsStub,
  assertSponsorshipValidity,
  decodeVerifyingPaymasterValidity,
  paymasterCodeMatches,
  type PaymasterServiceTransport,
  type PaymasterSponsorshipConfig,
} from "./erc4337-paymaster";

const paymaster = getAddress("0x3333333333333333333333333333333333333333");
const code = "0x60016000" as Hex;
const stubData: Hex = `0x${"ff".repeat(129)}`;

function finalData(validUntil = 1_700_001_000n, validAfter = 1_699_999_000n) {
  return concat([
    encodeAbiParameters(
      [{ type: "uint48" }, { type: "uint48" }],
      [Number(validUntil), Number(validAfter)],
    ),
    `0x${"11".repeat(65)}`,
  ]);
}

function config(
  overrides: Partial<PaymasterSponsorshipConfig> = {},
): PaymasterSponsorshipConfig {
  return {
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
    ...overrides,
  };
}

function operation(): Erc4337UserOperationV07 {
  return {
    sender: getAddress("0x1111111111111111111111111111111111111111"),
    nonce: 7n,
    callData: "0x1234",
    callGasLimit: 50_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 25_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    signature: `0x${"11".repeat(65)}`,
  };
}

function service() {
  const request = vi.fn(({ method }: { method: string }) => {
    if (method === "pm_getPaymasterStubData") {
      return Promise.resolve({
        paymaster,
        paymasterData: stubData,
        paymasterVerificationGasLimit: numberToHex(120_000n),
        paymasterPostOpGasLimit: numberToHex(60_000n),
        isFinal: false,
        ignoredVendorField: "not copied",
      });
    }
    return Promise.resolve({ paymaster, paymasterData: finalData() });
  });
  return { request } satisfies PaymasterServiceTransport & {
    request: ReturnType<typeof vi.fn>;
  };
}

describe("ERC-7677 paymaster client", () => {
  it("uses the v0.7 stub/final methods without an account signature or retry", async () => {
    const transport = service();
    const client = new PatioPaymasterClient(transport, config());
    const stub = await client.getStubData(operation());
    const final = await client.getFinalData({
      operation: { ...operation(), signature: "0x" },
      stub,
      chainTimestamp: 1_700_000_000n,
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(transport.request.mock.calls[0]?.[0]).toMatchObject({
      method: "pm_getPaymasterStubData",
    });
    expect(JSON.stringify(transport.request.mock.calls)).not.toContain(
      operation().signature,
    );
    expect(final).toMatchObject({
      paymaster,
      paymasterVerificationGasLimit: 120_000n,
      paymasterPostOpGasLimit: 60_000n,
      validUntil: 1_700_001_000n,
      validAfter: 1_699_999_000n,
    });
    expect(final).not.toHaveProperty("ignoredVendorField");
  });

  it("honors isFinal without making a second service request", async () => {
    const data = finalData();
    const transport = {
      request: vi.fn(() =>
        Promise.resolve({
          paymaster,
          paymasterData: data,
          paymasterVerificationGasLimit: "0x1d4c0",
          paymasterPostOpGasLimit: "0xea60",
          isFinal: true,
        }),
      ),
    };
    const client = new PatioPaymasterClient(transport, config());
    const stub = await client.getStubData(operation());
    await client.getFinalData({
      operation: operation(),
      stub,
      chainTimestamp: 1_700_000_000n,
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched contracts, excessive gas and malformed responses", async () => {
    for (const response of [
      {
        paymaster: getAddress("0x4444444444444444444444444444444444444444"),
        paymasterData: stubData,
        paymasterVerificationGasLimit: "0x1",
        paymasterPostOpGasLimit: "0x1",
      },
      {
        paymaster,
        paymasterData: stubData,
        paymasterVerificationGasLimit: numberToHex(200_001n),
        paymasterPostOpGasLimit: "0x1",
      },
      { paymaster },
    ]) {
      const client = new PatioPaymasterClient(
        { request: () => Promise.resolve(response) },
        config(),
      );
      await expect(client.getStubData(operation())).rejects.toBeInstanceOf(
        PaymasterServiceError,
      );
    }
  });

  it("binds final-data size, validity and the approved code hash", () => {
    expect(decodeVerifyingPaymasterValidity(finalData())).toEqual({
      validUntil: 1_700_001_000n,
      validAfter: 1_699_999_000n,
    });
    expect(() =>
      assertFinalDataFitsStub({ stubData: "0xffff", finalData: "0xff" }),
    ).toThrow("size assumptions");
    expect(() =>
      assertSponsorshipValidity({
        validAfter: 1_700_000_001n,
        validUntil: 1_700_001_000n,
        chainTimestamp: 1_700_000_000n,
        minimumValiditySeconds: 60n,
      }),
    ).toThrow("not valid yet");
    expect(paymasterCodeMatches(code, config())).toBe(true);
    expect(paymasterCodeMatches("0x6002", config())).toBe(false);
  });

  it("redacts endpoint credentials and never retries a quote", async () => {
    const transport = {
      request: vi.fn(() =>
        Promise.reject(
          new Error("https://sponsor.invalid/key?token=secret api-key=secret"),
        ),
      ),
    };
    const client = new PatioPaymasterClient(transport, config());
    await expect(client.getStubData(operation())).rejects.not.toThrow(
      /sponsor\.invalid|secret/u,
    );
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
});

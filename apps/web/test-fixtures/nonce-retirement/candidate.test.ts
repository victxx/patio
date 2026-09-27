import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildRetirementCandidate,
  validateRetirementRequests,
  validateRetirementSignatures,
  type RetirementInput,
} from "./candidate";

const input: RetirementInput = {
  session: "0x1111111111111111111111111111111111111111",
  chainId: 1337,
  gap: 0,
  highestMediaNonce: 4,
  code: "0x",
  inventory: {
    freshExclusiveLocalKey: true,
    frozen: true,
    ordinaryNonces: [],
    authorityNonces: [],
    mediaNonces: [1, 2, 3, 4, 4],
  },
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  balance: 1_000_000_000_000_000n,
};

describe("isolated atomic retirement construction policy", () => {
  it("validates tuple authority/signature before any outer signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const plan = buildRetirementCandidate({
      ...input,
      session: account.address,
    });
    const signed = await Promise.all(
      plan.authorizationRequests.map((a) => account.signAuthorization(a)),
    );
    await expect(
      validateRetirementSignatures(plan, signed),
    ).resolves.toBeUndefined();
    await expect(
      validateRetirementSignatures(plan, [
        { ...signed[0]!, r: `0x${"00".repeat(32)}` },
        ...signed.slice(1),
      ]),
    ).rejects.toThrow();
    await expect(
      validateRetirementSignatures(plan, [
        await other.signAuthorization(plan.authorizationRequests[0]!),
        ...signed.slice(1),
      ]),
    ).rejects.toThrow();
  });
  it("builds only the entire frozen range without a delegated call", () => {
    const plan = buildRetirementCandidate(input);
    expect(plan.authorizationRequests.map((a) => a.nonce)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(plan).toMatchObject({
      nonce: 0,
      value: 0n,
      data: "0x",
      gas: 121_000n,
      expectedNonce: 5,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() =>
      validateRetirementRequests(plan, plan.authorizationRequests),
    ).not.toThrow();
  });
  it("rejects a legacy gap signature, gap authorization and uncovered media before signing", () => {
    for (const inventory of [
      { ...input.inventory, ordinaryNonces: [0] },
      { ...input.inventory, authorityNonces: [0] },
      { ...input.inventory, mediaNonces: [1, 5] },
    ])
      expect(() => buildRetirementCandidate({ ...input, inventory })).toThrow(
        "Unsafe signature inventory",
      );
  });
  it("rejects missing, reordered, wrong-chain and wrong-start authorization requests", () => {
    const plan = buildRetirementCandidate(input);
    for (const requests of [
      plan.authorizationRequests.slice(1),
      [...plan.authorizationRequests].reverse(),
      plan.authorizationRequests.map((a) => ({ ...a, chainId: 560048 })),
      plan.authorizationRequests.map((a) => ({ ...a, nonce: a.nonce - 1 })),
    ])
      expect(() => validateRetirementRequests(plan, requests)).toThrow();
  });
  it("reserves pre-refund intrinsic gas plus a distinct plain-EOA sweep", () => {
    expect(buildRetirementCandidate(input).sweepReserve).toBe(
      42_000_000_000_000n,
    );
    expect(() =>
      buildRetirementCandidate({ ...input, balance: 284_000_000_000_000n }),
    ).toThrow("Insufficient");
    expect(
      buildRetirementCandidate({
        ...input,
        highestMediaNonce: 1,
        inventory: { ...input.inventory, mediaNonces: [1] },
      }).gas,
    ).toBe(46_000n);
  });
  it("refuses public chains, code-bearing accounts and numeric overflow", () => {
    for (const change of [
      { chainId: 560048 },
      { chainId: 0 },
      { code: "0x00" as const },
      { highestMediaNonce: 2 ** 64 },
      { maxFeePerGas: 1n << 256n },
    ])
      expect(() => buildRetirementCandidate({ ...input, ...change })).toThrow();
  });
});

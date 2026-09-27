/** H2.2 validated construction. Pure; only the contained private transport may use it. */
import {
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type SignedAuthorization,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";

export const LOCAL_CHAIN_ID = 1337;
export const EXECUTOR_VERSION = "1.15.6-stable-19d2b4c8";
export const FORK = "Prague";

export interface SignatureInventory {
  // This is an assumption backed by the local fixture's exclusive fresh key
  // custody, NOT something a validator can prove about an arbitrary old key.
  freshExclusiveLocalKey: true;
  frozen: true;
  ordinaryNonces: readonly number[];
  authorityNonces: readonly number[];
  mediaNonces: readonly number[]; // Includes uncertain and never-submitted media.
}

export interface RetirementInput {
  session: Address;
  chainId: number;
  gap: number;
  highestMediaNonce: number;
  code: Hex;
  inventory: SignatureInventory;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  balance: bigint;
}

export function buildRetirementCandidate(input: RetirementInput) {
  const { gap, highestMediaNonce: highest, inventory } = input;
  if (
    !isAddress(input.session) ||
    input.session === zeroAddress ||
    input.chainId !== LOCAL_CHAIN_ID ||
    input.code !== "0x" ||
    inventory.freshExclusiveLocalKey !== true ||
    inventory.frozen !== true ||
    !Number.isSafeInteger(gap) ||
    !Number.isSafeInteger(highest) ||
    gap < 0 ||
    highest <= gap ||
    highest - gap > 4 ||
    highest >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("Unsupported isolated retirement context");
  if (
    input.balance < 0n ||
    input.balance >= 1n << 256n ||
    inventory.ordinaryNonces.length !== 0 ||
    inventory.authorityNonces.length !== 0 ||
    inventory.mediaNonces.length === 0 ||
    inventory.mediaNonces.some(
      (nonce) =>
        !Number.isSafeInteger(nonce) || nonce <= gap || nonce > highest,
    )
  )
    throw new Error("Unsafe signature inventory");
  if (
    input.maxFeePerGas <= 0n ||
    input.maxFeePerGas >= 1n << 256n ||
    input.maxPriorityFeePerGas < 0n ||
    input.maxPriorityFeePerGas > input.maxFeePerGas
  )
    throw new Error("Invalid fee bounds");
  const gas = 21_000n + 25_000n * BigInt(highest - gap);
  const sweepReserve = 21_000n * input.maxFeePerGas;
  if (input.balance <= gas * input.maxFeePerGas + sweepReserve)
    throw new Error("Insufficient close plus separate sweep reserve");
  return Object.freeze({
    type: "eip7702" as const,
    chainId: input.chainId,
    to: input.session,
    nonce: gap,
    value: 0n,
    data: "0x" as const,
    gas,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    authorizationRequests: Object.freeze(
      Array.from({ length: highest - gap }, (_, i) =>
        Object.freeze({
          address: zeroAddress,
          chainId: input.chainId,
          nonce: gap + i + 1,
        }),
      ),
    ),
    expectedNonce: highest + 1,
    sweepReserve,
  });
}

/** Reject partial/reordered/wrong-scope requests BEFORE requesting signatures. */
export function validateRetirementRequests(
  candidate: ReturnType<typeof buildRetirementCandidate>,
  requests: readonly { address: Address; chainId: number; nonce: number }[],
): void {
  if (
    requests.length !== candidate.authorizationRequests.length ||
    requests.some((request, i) => {
      const expected = candidate.authorizationRequests[i]!;
      return (
        request.address !== zeroAddress ||
        request.chainId !== expected.chainId ||
        request.nonce !== expected.nonce
      );
    })
  )
    throw new Error("Incomplete or modified retirement range");
}

/** Validate produced tuple signatures before signing the outer transaction. */
export async function validateRetirementSignatures(
  candidate: ReturnType<typeof buildRetirementCandidate>,
  signed: readonly SignedAuthorization[],
): Promise<void> {
  validateRetirementRequests(candidate, signed);
  for (const authorization of signed) {
    const s = BigInt(authorization.s);
    if (
      s === 0n ||
      s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n ||
      (authorization.yParity !== 0 && authorization.yParity !== 1) ||
      (await recoverAuthorizationAddress({ authorization })).toLowerCase() !==
        candidate.to.toLowerCase()
    )
      throw new Error("Invalid retirement authority signature");
  }
}

import { getAddress, isAddress, isHex, type Address } from "viem";

/** EIP-7702 canonical delegation designator: 0xef0100 || 20-byte delegate. */
export const EIP7702_DELEGATION_DESIGNATOR = "0xef0100" as const;

export type AccountCodeKind =
  "no-code" | "eip7702-delegation" | "contract-code" | "unknown-code-bearing";

export type AccountCodeClassification =
  | { kind: "no-code" }
  | { kind: "eip7702-delegation"; delegate: Address }
  | { kind: "contract-code" }
  | { kind: "unknown-code-bearing" };

export function parseEip7702Delegation(
  code: string,
): { delegated: true; delegate: Address } | null {
  if (!isHex(code, { strict: true })) return null;
  if (!code.toLowerCase().startsWith(EIP7702_DELEGATION_DESIGNATOR)) {
    return null;
  }
  // The designation is exactly the prefix plus one 20-byte address.
  if (code.length !== 48) return null;
  const delegate = `0x${code.slice(EIP7702_DELEGATION_DESIGNATOR.length)}`;
  if (!isAddress(delegate)) return null;
  return { delegated: true, delegate: getAddress(delegate) };
}

/** Read-only canonical account-code classification; unknown is never upgraded to delegation. */
export function classifyAccountCode(code: string): AccountCodeClassification {
  if (code === "0x") return { kind: "no-code" };
  const delegation = parseEip7702Delegation(code);
  if (delegation)
    return { kind: "eip7702-delegation", delegate: delegation.delegate };
  if (!isHex(code, { strict: true })) return { kind: "unknown-code-bearing" };
  return code.toLowerCase().startsWith(EIP7702_DELEGATION_DESIGNATOR)
    ? { kind: "unknown-code-bearing" }
    : { kind: "contract-code" };
}

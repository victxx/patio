import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import {
  classifyAccountCode,
  EIP7702_DELEGATION_DESIGNATOR,
  parseEip7702Delegation,
} from "./index";

const address = (suffix: string): Address => `0x${suffix.padStart(40, "0")}`;

describe("EIP-7702 delegation designator", () => {
  it("recognizes only the exact 0xef0100 plus 20-byte delegate designation", () => {
    const code = `${EIP7702_DELEGATION_DESIGNATOR}${address("d").slice(2)}`;
    expect(parseEip7702Delegation(code)).toEqual({
      delegated: true,
      delegate: address("d"),
    });
    expect(classifyAccountCode(code)).toEqual({
      kind: "eip7702-delegation",
      delegate: address("d"),
    });
  });

  it("distinguishes no code, contract bytecode, and malformed designators", () => {
    expect(classifyAccountCode("0x")).toEqual({ kind: "no-code" });
    expect(classifyAccountCode("0x60016000")).toEqual({
      kind: "contract-code",
    });
    expect(classifyAccountCode(`${EIP7702_DELEGATION_DESIGNATOR}00`)).toEqual({
      kind: "unknown-code-bearing",
    });
    expect(parseEip7702Delegation("0xef0100zz")).toBeNull();
  });
});

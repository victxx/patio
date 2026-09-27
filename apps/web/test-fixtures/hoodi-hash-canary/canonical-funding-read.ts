/** Explicit, pinned read role for TWO known historical blocks, not provider fallback. */
import type { Hex } from "viem";
import type { LabRpc } from "./rpc";
export function installCanonicalFundingRead(
  read: LabRpc,
  canonical: LabRpc,
  report: Record<string, unknown>,
) {
  const repair = report.liveFundingRepair as
    { startClaimed: boolean; installed: boolean } | undefined;
  if (
    !repair?.installed ||
    repair.startClaimed ||
    report.publicSends !== 0 ||
    read.provider !== "chainstack" ||
    canonical.provider !== "alchemy" ||
    report.canonicalFundingRead
  )
    throw new Error(
      "Historical role cannot change during execution or be installed twice",
    );
  const blocks: Readonly<Record<string, Hex>> = Object.freeze({
    "0x386d98":
      "0x2459ec9680d8017bad831e1d4f77f08479a6384c3cbe4f2d00e356f3bc594230",
    "0x386da9":
      "0xd7f363a7788d700d3dd7efb54eaa0247c504d1efc310a4b7ee2fd1254466452a",
  });
  const evidence = {
    provider: "alchemy",
    purpose: "known funding canonical blocks only",
    maximumCalls: 4,
    blocks,
    calls: [] as { block: string; matched: boolean }[],
  };
  report.canonicalFundingRead = evidence;
  const original = read.request.bind(read);
  let verifiedChain = false;
  read.request = async <T>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    const block = typeof params[0] === "string" ? params[0] : "";
    if (method !== "eth_getBlockByNumber" || !Object.hasOwn(blocks, block))
      return original<T>(method, params);
    if (
      params.length !== 2 ||
      params[1] !== false ||
      evidence.calls.length >= evidence.maximumCalls
    )
      throw new Error("Outside bounded historical block read");
    const row = { block, matched: false };
    evidence.calls.push(row);
    if (!verifiedChain) {
      if ((await canonical.chainId()) !== 560048)
        throw new Error("Canonical reader wrong chain");
      verifiedChain = true;
    }
    const result = await canonical.request<{ number: Hex; hash: Hex }>(
      method,
      params,
    );
    if (result.number !== block || result.hash !== blocks[block])
      throw new Error("Historical canonical evidence changed");
    row.matched = true;
    return result as T;
  };
  return {
    provider: evidence.provider,
    blocks: Object.keys(blocks),
    maximumCalls: evidence.maximumCalls,
  };
}

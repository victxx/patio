/** Local-only executable experiment. NEVER imported by the app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keccak256,
  toRlp,
  zeroAddress,
  type Hex,
  type SignedAuthorization,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildRetirementCandidate,
  EXECUTOR_VERSION,
  FORK,
  LOCAL_CHAIN_ID,
  validateRetirementRequests,
  validateRetirementSignatures,
} from "./candidate";

const evm = process.env.PATIO_LOCAL_EVM;
assert(
  evm,
  "Set PATIO_LOCAL_EVM to the pinned Geth evm executable; no mock fallback",
);
const version = execFileSync(evm, ["--version"], { encoding: "utf8" });
assert(version.includes(EXECUTOR_VERSION), `Wrong executor: ${version}`);
const root = mkdtempSync(join(tmpdir(), "patio-retirement-"));
let session = privateKeyToAccount(generatePrivateKey());
let third = privateKeyToAccount(generatePrivateKey());
const fee = {
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};
const balance = 10n ** 18n;
type Alloc = Record<string, { balance: string; nonce?: string; code?: string }>;
interface Result {
  receipts: { transactionHash: Hex; gasUsed: string; status: string }[];
  rejected?: { index: number; error: string }[];
}
interface Transition {
  alloc: Alloc;
  result: Result;
}
let initial: Alloc = {
  [session.address]: { balance: `0x${balance.toString(16)}`, nonce: "0x0" },
  [third.address]: { balance: `0x${balance.toString(16)}`, nonce: "0x0" },
};
function freshContext() {
  session = privateKeyToAccount(generatePrivateKey());
  third = privateKeyToAccount(generatePrivateKey());
  initial = {
    [session.address]: { balance: `0x${balance.toString(16)}`, nonce: "0x0" },
    [third.address]: { balance: `0x${balance.toString(16)}`, nonce: "0x0" },
  };
}
let runNumber = 0;
const observations: Record<string, unknown>[] = [];
function execute(name: string, txs: Hex[], alloc = initial): Transition {
  const dir = mkdtempSync(join(root, `${++runNumber}-`));
  writeFileSync(join(dir, "alloc.json"), JSON.stringify(alloc));
  writeFileSync(
    join(dir, "env.json"),
    JSON.stringify({
      currentCoinbase: zeroAddress,
      currentGasLimit: "0x1c9c380",
      currentNumber: "0x1",
      currentTimestamp: "0x1",
      currentRandom: "0x0",
      currentBaseFee: "0x3b9aca00",
      withdrawals: [],
      currentExcessBlobGas: "0x0",
      parentBeaconBlockRoot: `0x${"00".repeat(32)}`,
    }),
  );
  writeFileSync(join(dir, "txs.rlp"), JSON.stringify(toRlp(txs)));
  execFileSync(
    evm!,
    [
      "t8n",
      "--state.fork",
      FORK,
      "--state.chainid",
      String(LOCAL_CHAIN_ID),
      "--input.alloc",
      join(dir, "alloc.json"),
      "--input.env",
      join(dir, "env.json"),
      "--input.txs",
      join(dir, "txs.rlp"),
      "--output.basedir",
      dir,
      "--output.alloc",
      "post.json",
      "--output.result",
      "result.json",
    ],
    { stdio: "pipe", timeout: 20_000 },
  );
  const post = JSON.parse(
    readFileSync(join(dir, "post.json"), "utf8"),
  ) as Alloc;
  const result = JSON.parse(
    readFileSync(join(dir, "result.json"), "utf8"),
  ) as Result;
  const account = post[session.address.toLowerCase()]!;
  observations.push({
    name,
    nonce: Number(BigInt(account.nonce ?? "0x0")),
    code: account.code ?? "0x",
    sessionBalanceWei: BigInt(account.balance).toString(),
    gasUsed: result.receipts.map((r) => Number(BigInt(r.gasUsed))),
    receiptStatus: result.receipts.map((r) => r.status),
    included: result.receipts.map((r) => r.transactionHash),
    rejected: result.rejected ?? [],
  });
  return { alloc: post, result };
}
function nonce(t: Transition) {
  return Number(BigInt(t.alloc[session.address.toLowerCase()]?.nonce ?? "0x0"));
}
function included(t: Transition, raw: Hex) {
  return t.result.receipts.some((r) => r.transactionHash === keccak256(raw));
}
function excluded(t: Transition, raw: Hex) {
  assert(!included(t, raw), "Included media is a failure even if reverted");
}
const media = (n: number, multiplier = 1n) =>
  session.signTransaction({
    type: "eip1559",
    chainId: LOCAL_CHAIN_ID,
    nonce: n,
    to: third.address,
    value: 0n,
    data: "0x504154494f2d53594e544845544943",
    gas: 30_000n,
    maxFeePerGas: fee.maxFeePerGas * multiplier,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas * multiplier,
  });
const auths = async (count: number) =>
  Promise.all(
    Array.from({ length: count }, (_, i) =>
      session.signAuthorization({
        address: zeroAddress,
        chainId: LOCAL_CHAIN_ID,
        nonce: i + 1,
      }),
    ),
  );
const rawClose = (
  list: SignedAuthorization[],
  options: { gas?: bigint; doubledFee?: boolean } = {},
) =>
  session.signTransaction({
    type: "eip7702",
    chainId: LOCAL_CHAIN_ID,
    nonce: 0,
    to: session.address,
    value: 0n,
    data: "0x",
    authorizationList: list,
    gas: options.gas ?? 21_000n + 25_000n * BigInt(list.length),
    maxFeePerGas: fee.maxFeePerGas * (options.doubledFee ? 2n : 1n),
    maxPriorityFeePerGas:
      fee.maxPriorityFeePerGas * (options.doubledFee ? 2n : 1n),
  });
async function checkedClose(count: number) {
  const plan = buildRetirementCandidate({
    session: session.address,
    chainId: LOCAL_CHAIN_ID,
    gap: 0,
    highestMediaNonce: count,
    code: "0x",
    balance,
    ...fee,
    inventory: {
      freshExclusiveLocalKey: true,
      frozen: true,
      ordinaryNonces: [],
      authorityNonces: [],
      mediaNonces: Array.from({ length: count }, (_, i) => i + 1),
    },
  });
  validateRetirementRequests(plan, plan.authorizationRequests);
  const signed = await auths(count);
  await validateRetirementSignatures(plan, signed);
  return rawClose(signed);
}

// Each scenario starts from the same isolated genesis, not a nonce override.
// These deliberately unsafe signatures exist ONLY in adversarial branches;
// they are never mixed into a positive branch's signature inventory.
async function main() {
  for (const count of [1, 4]) {
    freshContext();
    const candidates = await Promise.all(
      Array.from({ length: count }, (_, i) => media(i + 1)),
    );
    const oldReplacement = await media(1, 2n);
    const close = await checkedClose(count);
    const before = execute(`${count}: media before close`, candidates);
    assert.equal(nonce(before), 0);
    candidates.forEach((raw) => excluded(before, raw));
    const closed = execute(`${count}: close then retained media`, [
      close,
      ...candidates,
      oldReplacement,
    ]);
    assert.equal(nonce(closed), count + 1);
    assert.equal(closed.result.receipts[0]!.status, "0x1");
    assert.equal(
      closed.alloc[session.address.toLowerCase()]!.code ?? "0x",
      "0x",
    );
    candidates.forEach((raw) => excluded(closed, raw));
    excluded(closed, oldReplacement);
    assert.equal(
      Number(BigInt(closed.result.receipts[0]!.gasUsed)),
      count === 1 ? 36_800 : 96_800,
    );
    const remaining = BigInt(
      closed.alloc[session.address.toLowerCase()]!.balance,
    );
    const sweep = await session.signTransaction({
      type: "eip1559",
      chainId: LOCAL_CHAIN_ID,
      nonce: count + 1,
      to: third.address,
      value: remaining - 21_000n * fee.maxFeePerGas,
      data: "0x",
      gas: 21_000n,
      ...fee,
    });
    const swept = execute(
      `${count}: subsequent transfer`,
      [sweep],
      closed.alloc,
    );
    assert(included(swept, sweep));
    assert.equal(
      BigInt(swept.alloc[session.address.toLowerCase()]!.balance),
      0n,
    );
    const bothOrders = execute(`${count}: producer media, close, media`, [
      ...candidates,
      close,
      ...candidates,
    ]);
    assert.equal(nonce(bothOrders), count + 1);
    candidates.forEach((raw) => excluded(bothOrders, raw));
  }
  freshContext();
  let list = await auths(4);
  let close = await rawClose(list);
  for (const [label, stolen] of [
    ["individual", [list[0]!]],
    ["subset", list.slice(0, 2)],
    ["reordered", [...list].reverse()],
  ] as const) {
    const theft = await third.signTransaction({
      type: "eip7702",
      chainId: LOCAL_CHAIN_ID,
      nonce: 0,
      to: third.address,
      value: 0n,
      gas: 21_000n + 25_000n * BigInt(stolen.length),
      ...fee,
      authorizationList: stolen,
    });
    const stolenState = execute(`third party ${label} before close`, [theft]);
    assert.equal(nonce(stolenState), 0);
    assert.equal(
      nonce(execute(`close after ${label} theft`, [close], stolenState.alloc)),
      5,
    );
  }
  // Unsafe branches deliberately bypass the constructor, on a distinct key.
  freshContext();
  list = await auths(4);
  close = await rawClose(list);
  let m1 = await media(1);
  const m2 = await media(2);
  const m4 = await media(4);
  const m5 = await media(5);
  const release = await session.signTransaction({
    type: "eip1559",
    chainId: LOCAL_CHAIN_ID,
    nonce: 0,
    to: session.address,
    value: 0n,
    data: "0x",
    gas: 21_000n,
    ...fee,
  });
  assert(
    included(execute("UNSAFE legacy release then media", [release, m1]), m1),
  );
  const authZero = await session.signAuthorization({
    address: zeroAddress,
    chainId: LOCAL_CHAIN_ID,
    nonce: 0,
  });
  const stolenZero = await third.signTransaction({
    type: "eip7702",
    chainId: LOCAL_CHAIN_ID,
    nonce: 0,
    to: third.address,
    value: 0n,
    gas: 46_000n,
    ...fee,
    authorizationList: [authZero],
  });
  assert(
    included(
      execute("UNSAFE copied authority nonce g opens gap", [stolenZero, m1]),
      m1,
    ),
  );
  assert(
    included(
      execute("UNSAFE self-close starting g only", [
        await rawClose([authZero]),
        m1,
      ]),
      m1,
    ),
  );
  assert(
    included(
      execute("UNSAFE missing final authorization", [
        await rawClose(list.slice(0, 3)),
        m4,
      ]),
      m4,
    ),
  );
  assert(
    included(
      execute("UNSAFE reversed list", [
        await rawClose([...list].reverse()),
        m2,
      ]),
      m2,
    ),
  );
  const wrongChain = await session.signAuthorization({
    address: zeroAddress,
    chainId: 1338,
    nonce: 1,
  });
  assert(
    included(
      execute("UNSAFE wrong chain first tuple", [
        await rawClose([wrongChain, ...list.slice(1)]),
        m1,
      ]),
      m1,
    ),
  );
  const invalid: SignedAuthorization = {
    ...list[0]!,
    r: `0x${"00".repeat(32)}`,
  };
  assert(
    included(
      execute("UNSAFE invalid signature first tuple", [
        await rawClose([invalid, ...list.slice(1)]),
        m1,
      ]),
      m1,
    ),
  );
  assert(included(execute("UNSAFE uncovered media M+1", [close, m5]), m5));
  const shortGas = execute("insufficient intrinsic gas", [
    await rawClose(list, { gas: 120_999n }),
    m1,
  ]);
  assert.equal(nonce(shortGas), 0);
  excluded(shortGas, m1);
  const poor = structuredClone(initial);
  poor[session.address]!.balance = "0x1";
  assert.equal(nonce(execute("insufficient balance", [close], poor)), 0);
  // Restore exclusive safe signature inventory with a NEW key, never a nonce setter.
  freshContext();
  m1 = await media(1);
  list = await auths(4);
  close = await rawClose(list);
  const close2 = await rawClose(list, { doubledFee: true });
  for (const pair of [
    [close, close2],
    [close2, close],
  ]) {
    const competition = execute("fee-only closing candidates", [...pair, m1]);
    assert.equal(nonce(competition), 5);
    assert.equal(competition.result.receipts.length, 1);
    excluded(competition, m1);
  }
  // Reorg model: execute competing branch from saved parent allocation. No nonce setter.
  const retired = execute("branch A includes close", [close]);
  const reorg = execute(
    "branch B replaces close block with no close",
    [m1],
    initial,
  );
  assert.equal(nonce(retired), 5);
  assert.equal(nonce(reorg), 0);
  excluded(reorg, m1);
  assert.equal(
    nonce(execute("reinclude close after reorg", [close], reorg.alloc)),
    5,
  );
  const topup = await third.signTransaction({
    type: "eip1559",
    chainId: LOCAL_CHAIN_ID,
    nonce: 0,
    to: session.address,
    value: 123n,
    gas: 21_000n,
    ...fee,
  });
  const funded = execute(
    "additional funds after retirement",
    [topup, m1],
    retired.alloc,
  );
  assert.equal(nonce(funded), 5);
  excluded(funded, m1);
  assert.equal(
    BigInt(funded.alloc[session.address.toLowerCase()]!.balance),
    BigInt(retired.alloc[session.address.toLowerCase()]!.balance) + 123n,
  );
  console.log(
    JSON.stringify(
      {
        executor: version.trim(),
        fork: FORK,
        chainId: LOCAL_CHAIN_ID,
        note: "t8n rejects invalid candidates; an actual block containing one would be invalid. This is NOT txpool admission or consensus fork choice.",
        observations,
      },
      null,
      2,
    ),
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

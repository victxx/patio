import type { Hex } from "viem";

export type RetirementState =
  | "prepared"
  | "broadcasting"
  | "media-frozen"
  | "close-submitting"
  | "close-pending"
  | "close-included"
  | "sweep-submitting"
  | "complete"
  | "held-before-close"
  | "held-close-uncertain"
  | "held-after-close"
  | "sweep-pending"
  | "safety-failed";
export interface SignatureMetadata {
  role: "media" | "retirement-close" | "sweep";
  hash: Hex;
  nonce: number;
  index?: number;
  maxFee: string;
  tip: string;
}
const transitions: Partial<
  Record<RetirementState, readonly RetirementState[]>
> = {
  prepared: ["broadcasting", "media-frozen"],
  broadcasting: ["media-frozen"],
  "media-frozen": ["close-submitting", "held-before-close"],
  "close-submitting": ["close-pending", "held-close-uncertain"],
  "close-pending": ["close-included", "held-close-uncertain"],
  "held-close-uncertain": ["close-included"],
  "close-included": ["sweep-submitting", "held-after-close"],
  "sweep-submitting": ["complete", "sweep-pending", "held-after-close"],
  "sweep-pending": ["complete", "held-after-close"],
};

/** Metadata only. The controller owns the sole key; this ledger never signs. */
export class RetirementInventory {
  readonly g: number;
  readonly m: number;
  readonly s: number;
  #state: RetirementState = "prepared";
  #records: SignatureMetadata[] = [];
  #frozenAt: number | null = null;
  constructor(
    g: number,
    readonly capacity: number,
  ) {
    if (
      !Number.isSafeInteger(g) ||
      g < 0 ||
      g > Number.MAX_SAFE_INTEGER - 2 ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 20
    )
      throw new Error("Invalid inventory");
    this.g = g;
    this.m = g + 1;
    this.s = g + 2;
  }
  get state() {
    return this.#state;
  }
  get mediaCount() {
    return this.#records.filter((r) => r.role === "media").length;
  }
  transition(next: RetirementState) {
    if (!(transitions[this.#state] ?? []).includes(next))
      throw new Error("Illegal retirement transition");
    this.#state = next;
  }
  freeze() {
    this.#frozenAt ??= performance.now();
    if (this.#state === "prepared" || this.#state === "broadcasting")
      this.transition("media-frozen");
  }
  safetyFailure() {
    this.freeze();
    this.#state = "safety-failed";
  }
  invalidateCanonicalEvidence() {
    this.freeze();
    if (this.#state !== "safety-failed") this.#state = "held-close-uncertain";
  }
  assertIntent(role: string, nonce: number, index?: number) {
    const valid =
      role === "media"
        ? this.#state === "broadcasting" &&
          this.#frozenAt === null &&
          nonce === this.m &&
          index === this.mediaCount &&
          this.mediaCount < this.capacity
        : role === "retirement-close"
          ? this.#state === "media-frozen" &&
            this.#frozenAt !== null &&
            nonce === this.g &&
            !this.#records.some((r) => r.role === "retirement-close")
          : role === "sweep" &&
            this.#state === "close-included" &&
            nonce === this.s &&
            !this.#records.some((r) => r.role === "sweep");
    if (!valid)
      throw new Error("Forbidden signing intent; no signature produced");
  }
  record(record: SignatureMetadata) {
    this.assertIntent(record.role, record.nonce, record.index);
    if (this.#records.some((r) => r.hash === record.hash))
      throw new Error("Duplicate signature hash");
    const prior = this.#records.filter((r) => r.role === "media").at(-1);
    if (
      record.role === "media" &&
      prior &&
      (BigInt(record.maxFee) <= BigInt(prior.maxFee) ||
        BigInt(record.tip) <= BigInt(prior.tip))
    )
      throw new Error("Media fees must strictly increase");
    this.#records.push(Object.freeze({ ...record }));
  }
  snapshot() {
    return {
      state: this.#state,
      g: this.g,
      m: this.m,
      s: this.s,
      frozenAtMonotonicMs: this.#frozenAt,
      capacity: this.capacity,
      signatures: this.#records.map((r) => ({ ...r })),
    };
  }
}

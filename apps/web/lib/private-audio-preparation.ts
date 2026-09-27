import type { SingleNoncePlan } from "./single-nonce-plan";

export type AudioReview<C> = Readonly<{
  plan: SingleNoncePlan;
  context: C;
  binding: string;
  observedAt: number;
}>;
export const AUDIO_REVIEW_MAX_AGE_MS = 60_000;
export function audioPlanKey(plan: SingleNoncePlan): string {
  return JSON.stringify(plan, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
type PreparationDependencies<C, S> = {
  read(budget: bigint): Promise<AudioReview<C>>;
  create(review: AudioReview<C>): Promise<S>;
  plan(session: S): SingleNoncePlan;
  register(session: S, review: AudioReview<C>): Promise<void>;
  fund(session: S, beforeRequest: () => void): Promise<void>;
  confirm(session: S): Promise<void>;
  microphone(): void;
  now(): number;
};

/** Browser preparation coordinator only. No key, signing, sending or capture logic. */
export class PrivateAudioPreparation<C, S> {
  review: AudioReview<C> | null = null;
  session: S | null = null;
  busy = false;
  approved = false;
  fundingRequested = false;
  phase:
    | "idle"
    | "reviewing"
    | "preparing"
    | "prepared"
    | "held"
    | "funding-uncertain" = "idle";
  private active = true;
  constructor(private readonly deps: PreparationDependencies<C, S>) {}
  private ensureActive() {
    if (!this.active)
      throw new Error("Preparation view closed; no further action authorized");
  }
  invalidate() {
    if (this.busy || this.session) return false;
    this.review = null;
    this.approved = false;
    return true;
  }
  async read(budget: bigint) {
    this.ensureActive();
    if (this.busy || this.session)
      throw new Error(
        "Keep the existing preparation/session; no replacement attempt",
      );
    this.busy = true;
    this.approved = false;
    this.phase = "reviewing";
    this.review = null;
    try {
      const review = await this.deps.read(budget);
      this.ensureActive();
      this.review = review;
      return review;
    } finally {
      this.busy = false;
      this.phase = "idle";
    }
  }
  approve(value: boolean) {
    if (this.busy || this.session) return;
    this.approved = value && Boolean(this.review?.plan.allowed);
  }
  private check(review: AudioReview<C>) {
    this.ensureActive();
    this.deps.microphone();
    if (
      !this.approved ||
      this.review !== review ||
      !review.plan.allowed ||
      this.deps.now() - review.observedAt > AUDIO_REVIEW_MAX_AGE_MS ||
      this.deps.now() < review.observedAt
    )
      throw new Error("Review an affordable current plan before preparation");
  }
  async prepare() {
    if (this.busy || this.session)
      throw new Error(
        "Preparation already reserved; keep the existing session",
      );
    const review = this.review;
    if (!review) throw new Error("Review the plan first");
    this.check(review);
    this.busy = true;
    this.phase = "preparing";
    try {
      const fresh = await this.deps.read(review.plan.budget);
      this.check(review);
      if (
        fresh.binding !== review.binding ||
        audioPlanKey(fresh.plan) !== audioPlanKey(review.plan)
      ) {
        this.review = fresh;
        this.approved = false;
        throw new Error(
          "Plan or private environment changed. Review again; nothing funded.",
        );
      }
      this.session = await this.deps.create(review);
      this.check(review);
      if (
        audioPlanKey(this.deps.plan(this.session)) !== audioPlanKey(review.plan)
      )
        throw new Error(
          "Prepared plan changed; unfunded session held, no silent re-quote",
        );
      await this.deps.register(this.session, review);
      this.check(review);
      await this.deps.fund(this.session, () => {
        this.check(review); // last synchronous boundary before the funding request
        if (this.fundingRequested)
          throw new Error("Funding already requested; reconcile only");
        this.fundingRequested = true;
      });
      // Microphone may have ended during the request. Funding remains a separate fact.
      this.phase = "prepared";
      return this.session;
    } catch (error) {
      this.phase = this.fundingRequested
        ? "funding-uncertain"
        : this.session
          ? "held"
          : "idle";
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async reconcile() {
    this.ensureActive();
    if (this.busy || !this.session || !this.fundingRequested)
      throw new Error("No dispatched funding to reconcile");
    this.busy = true;
    try {
      await this.deps.confirm(this.session);
      this.phase = "prepared";
      return this.session;
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    this.active = false;
  }
}

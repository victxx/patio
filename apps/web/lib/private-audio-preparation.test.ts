/* Async simulated network adapters deliberately settle without real I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_REVIEW_MAX_AGE_MS,
  PrivateAudioPreparation,
  type AudioReview,
} from "./private-audio-preparation";
import { quoteSingleNonce } from "./single-nonce-plan";

function fixture(budget = 2_000_000_000_000_000n) {
  const plan = quoteSingleNonce({
    baseFee: 1n,
    priorityFee: 1_000_000_000n,
    candidates: 4,
    budget,
  });
  let review: AudioReview<null> = {
    plan,
    context: null,
    binding: "private-genesis/identities/roles/operator",
    observedAt: 1000,
  };
  const session = { plan };
  const deps = {
    read: vi.fn(async () => review),
    create: vi.fn(async () => session),
    plan: (s: typeof session) => s.plan,
    register: vi.fn(async () => undefined),
    fund: vi.fn(async (_s: typeof session, before: () => void) => {
      before();
    }),
    confirm: vi.fn(async () => undefined),
    microphone: vi.fn(),
    now: () => 1000,
  };
  const prep = new PrivateAudioPreparation(deps);
  const ready = async () => {
    await prep.read(budget);
    prep.approve(true);
  };
  return {
    deps,
    prep,
    session,
    ready,
    change: (patch: Partial<AudioReview<null>>) => {
      review = { ...review, ...patch };
    },
  };
}
describe("D2 real preparation coordinator guards (network adapters simulated)", () => {
  it("construction/review never creates, funds or captures; insufficient quote cannot be approved or auto-raised", async () => {
    const f = fixture(500_000_000_000_000n);
    expect(f.deps.read).not.toHaveBeenCalled();
    await f.ready();
    expect(f.prep.review?.plan.allowed).toBe(false);
    expect(f.prep.approved).toBe(false);
    await expect(f.prep.prepare()).rejects.toThrow("Review");
    expect(f.deps.create).not.toHaveBeenCalled();
    expect(f.deps.fund).not.toHaveBeenCalled();
    expect(f.prep.review?.plan.budget).toBe(500_000_000_000_000n);
  });
  it("double-click prepares/funds once; inputs freeze; no further session", async () => {
    const f = fixture();
    await f.ready();
    const a = f.prep.prepare();
    expect(f.prep.invalidate()).toBe(false);
    await expect(f.prep.prepare()).rejects.toThrow("reserved");
    expect(await a).toBe(f.session);
    expect(f.deps.create).toHaveBeenCalledTimes(1);
    expect(f.deps.fund).toHaveBeenCalledTimes(1);
    await expect(f.prep.prepare()).rejects.toThrow();
    expect(f.prep.invalidate()).toBe(false);
  });
  it("live microphone required before any key/session or funding", async () => {
    const f = fixture();
    await f.ready();
    f.deps.microphone.mockImplementation(() => {
      throw new Error("no live track");
    });
    await expect(f.prep.prepare()).rejects.toThrow("live track");
    expect(f.deps.create).not.toHaveBeenCalled();
    expect(f.deps.fund).not.toHaveBeenCalled();
  });
  it.each(["binding", "fees", "topology"])(
    "changed %s invalidates review before creating/funding",
    async (kind) => {
      const f = fixture();
      await f.ready();
      if (kind === "binding")
        f.change({ binding: "other chain/provider/account" });
      if (kind === "fees")
        f.change({
          plan: { ...f.session.plan, closeFee: f.session.plan.closeFee + 1n },
        });
      if (kind === "topology")
        f.deps.read.mockRejectedValueOnce(new Error("B missing"));
      await expect(f.prep.prepare()).rejects.toThrow();
      expect(f.deps.create).not.toHaveBeenCalled();
      expect(f.deps.fund).not.toHaveBeenCalled();
    },
  );
  it("budget change/stale review removes authority", async () => {
    const f = fixture();
    await f.ready();
    f.prep.invalidate();
    await expect(f.prep.prepare()).rejects.toThrow("Review");
    await f.ready();
    f.deps.now = () => AUDIO_REVIEW_MAX_AGE_MS + 1001;
    await expect(f.prep.prepare()).rejects.toThrow("Review");
    expect(f.deps.create).not.toHaveBeenCalled();
  });
  it("track loss at the last asynchronous funding boundary blocks the request and retains the unfunded session", async () => {
    const f = fixture();
    await f.ready();
    const request = vi.fn();
    f.deps.fund.mockImplementation(async (_s, before) => {
      f.deps.microphone.mockImplementation(() => {
        throw new Error("track ended");
      });
      before();
      request();
    });
    await expect(f.prep.prepare()).rejects.toThrow("track ended");
    expect(request).not.toHaveBeenCalled();
    expect(f.prep.session).toBe(f.session);
    expect(f.prep.phase).toBe("held");
  });
  it("network revalidation failure before funding request remains held, never retried", async () => {
    const f = fixture();
    await f.ready();
    f.deps.fund.mockImplementation(async () => {
      throw new Error("environment revalidation failed");
    });
    await expect(f.prep.prepare()).rejects.toThrow();
    expect(f.prep.fundingRequested).toBe(false);
    await expect(f.prep.prepare()).rejects.toThrow();
    expect(f.deps.fund).toHaveBeenCalledTimes(1);
  });
  it("timeout retains key/session and allows only read-only confirmation, not resend/replacement", async () => {
    const f = fixture();
    await f.ready();
    f.deps.fund.mockImplementation(async (_s, before) => {
      before();
      throw new Error("timeout");
    });
    await expect(f.prep.prepare()).rejects.toThrow("timeout");
    expect(f.prep.phase).toBe("funding-uncertain");
    expect(f.prep.session).toBe(f.session);
    await expect(f.prep.prepare()).rejects.toThrow();
    expect(await f.prep.reconcile()).toBe(f.session);
    expect(f.deps.confirm).toHaveBeenCalledTimes(1);
    expect(f.deps.fund).toHaveBeenCalledTimes(1);
  });
  it("microphone failure after funding is not funding failure; same session is usable after recheck", async () => {
    const f = fixture();
    await f.ready();
    f.deps.fund.mockImplementation(async (_s, before) => {
      before();
      f.deps.microphone.mockImplementation(() => {
        throw new Error("track ended after request");
      });
    });
    expect(await f.prep.prepare()).toBe(f.session);
    expect(f.prep.phase).toBe("prepared");
    f.deps.microphone.mockReset();
    expect(f.prep.session).toBe(f.session);
    await expect(f.prep.prepare()).rejects.toThrow();
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  it("unmount during revalidation cannot create or fund a session", async () => {
    const f = fixture();
    await f.ready();
    f.deps.read.mockImplementationOnce(async () => {
      f.prep.dispose();
      return f.prep.review!;
    });
    await expect(f.prep.prepare()).rejects.toThrow("closed");
    expect(f.deps.create).not.toHaveBeenCalled();
    expect(f.deps.fund).not.toHaveBeenCalled();
  });
});

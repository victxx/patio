import { describe, expect, it } from "vitest";

import { NonceGapSession } from "./index";

describe("NonceGapSession", () => {
  it("never assigns media to the held release nonce", () => {
    const session = new NonceGapSession(7n, 2, 2);
    session.start();
    expect(session.recordPacket()).toEqual({ nonce: 8n, replacementIndex: 0 });
    expect(session.recordPacket()).toEqual({ nonce: 8n, replacementIndex: 1 });
    expect(session.sealActiveWindow()).toBe(8n);
    expect(session.recordPacket()).toEqual({ nonce: 9n, replacementIndex: 0 });
  });

  it("cannot release until every transmitted window is independently confirmed", () => {
    const session = new NonceGapSession(20n, 2, 2);
    session.start();
    session.recordPacket();
    session.sealActiveWindow();
    session.requestStop();
    expect(() => session.releaseGap()).toThrow(/every seal/);
    session.confirmSeal(0);
    expect(session.releaseGap()).toBe(20n);
    expect(session.snapshot().state).toBe("released");
  });

  it("fails closed when the observer is unavailable", () => {
    const session = new NonceGapSession(0n, 1, 20);
    session.start();
    session.recordPacket();
    session.requestStop();
    session.fail("observer unavailable");
    expect(session.snapshot()).toMatchObject({
      state: "failed",
      failureReason: "observer unavailable",
    });
    expect(() => session.releaseGap()).toThrow();
  });
});

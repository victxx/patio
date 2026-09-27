import { describe, expect, it } from "vitest";

import {
  assertNewDirectBroadcastAllowed,
  DIRECT_TRANSPORT_SAFETY_BLOCK_MESSAGE,
} from "./direct-transport-safety";

describe("H2.1 direct transport containment", () => {
  it("blocks loopback RPCs too: a local proxy reporting Hoodi is not isolation", () => {
    expect(() =>
      assertNewDirectBroadcastAllowed({
        senderRpcUrl: "http://127.0.0.1:8545/sender",
        observerRpcUrl: "http://localhost:8546/observer",
      }),
    ).toThrow(DIRECT_TRANSPORT_SAFETY_BLOCK_MESSAGE);
  });

  it("blocks new public-network classic and optional setup before funding", () => {
    for (const urls of [
      {
        senderRpcUrl: "https://sender.example",
        observerRpcUrl: "https://observer.example",
      },
      {
        senderRpcUrl: "http://127.0.0.1:8545",
        observerRpcUrl: "https://observer.example",
      },
    ]) {
      expect(() => assertNewDirectBroadcastAllowed(urls)).toThrow(
        DIRECT_TRANSPORT_SAFETY_BLOCK_MESSAGE,
      );
    }
  });
});

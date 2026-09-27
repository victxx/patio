export type NonceGapSessionState =
  | "draft"
  | "streaming"
  | "awaiting-seals"
  | "ready-to-release"
  | "released"
  | "failed";

export interface NonceGapSessionSnapshot {
  state: NonceGapSessionState;
  nonceStart: bigint;
  nonceEnd: bigint;
  activeWindow: number;
  packetCountByWindow: readonly number[];
  sealedWindows: readonly number[];
  confirmedWindows: readonly number[];
  failureReason?: string;
}

export class NonceGapSession {
  private state: NonceGapSessionState = "draft";
  private activeWindow = 0;
  private readonly packetCounts: number[];
  private readonly sealed = new Set<number>();
  private readonly confirmed = new Set<number>();
  private failureReason?: string;

  public constructor(
    private readonly nonceStart: bigint,
    private readonly windows: number,
    private readonly replacementsPerWindow: number,
  ) {
    if (windows < 1 || replacementsPerWindow < 1) {
      throw new Error(
        "A nonce-gap session needs at least one window and replacement",
      );
    }
    this.packetCounts = Array.from({ length: windows }, () => 0);
  }

  public start(): void {
    if (this.state !== "draft") throw new Error("Session has already started");
    this.state = "streaming";
  }

  public recordPacket(): { nonce: bigint; replacementIndex: number } {
    if (this.state !== "streaming") {
      throw new Error("Packets can only be recorded while streaming");
    }
    if (this.activeWindow >= this.windows) {
      throw new Error("Every authorized nonce window is full");
    }
    const count = this.packetCounts[this.activeWindow] ?? 0;
    if (count >= this.replacementsPerWindow) {
      throw new Error("Active nonce window must be sealed before continuing");
    }
    this.packetCounts[this.activeWindow] = count + 1;
    return {
      nonce: this.nonceStart + 1n + BigInt(this.activeWindow),
      replacementIndex: count,
    };
  }

  public sealActiveWindow(): bigint {
    if (this.state !== "streaming") {
      throw new Error("Only a streaming session can seal a window");
    }
    if ((this.packetCounts[this.activeWindow] ?? 0) === 0) {
      throw new Error("Cannot seal an empty window");
    }
    this.sealed.add(this.activeWindow);
    const nonce = this.nonceStart + 1n + BigInt(this.activeWindow);
    this.activeWindow += 1;
    if (this.activeWindow >= this.windows) {
      this.state = "awaiting-seals";
    }
    return nonce;
  }

  public requestStop(): void {
    if (this.state !== "streaming") return;
    if (
      this.activeWindow < this.windows &&
      (this.packetCounts[this.activeWindow] ?? 0) > 0
    ) {
      this.sealActiveWindow();
    }
    this.state = "awaiting-seals";
  }

  public confirmSeal(windowIndex: number): void {
    if (!this.sealed.has(windowIndex)) {
      throw new Error("Observer cannot confirm a window that is not sealed");
    }
    this.confirmed.add(windowIndex);
    if (
      this.state === "awaiting-seals" &&
      [...this.sealed].every((window) => this.confirmed.has(window))
    ) {
      this.state = "ready-to-release";
    }
  }

  public releaseGap(): bigint {
    if (this.state !== "ready-to-release") {
      throw new Error(
        "Nonce gap cannot be released before every seal is confirmed",
      );
    }
    this.state = "released";
    return this.nonceStart;
  }

  public fail(reason: string): void {
    if (this.state === "released") {
      throw new Error("A released session cannot transition to failed");
    }
    this.failureReason = reason;
    this.state = "failed";
  }

  public snapshot(): NonceGapSessionSnapshot {
    return {
      state: this.state,
      nonceStart: this.nonceStart,
      nonceEnd: this.nonceStart + BigInt(this.windows),
      activeWindow: this.activeWindow,
      packetCountByWindow: [...this.packetCounts],
      sealedWindows: [...this.sealed].sort((a, b) => a - b),
      confirmedWindows: [...this.confirmed].sort((a, b) => a - b),
      ...(this.failureReason ? { failureReason: this.failureReason } : {}),
    };
  }
}

import type { DirectSessionDescriptor, DirectRpcConfig } from "./direct-hoodi";
import type { DirectFeePlan } from "./direct-plan";
/** Explicit review coordinator supplied by a host. The production Hoodi beta
 * additionally requires its exact runtime gate and bounded server adapter. */
export interface ControlledClassicTest {
  mode?: "hoodi-beta";
  rpcConfig?: DirectRpcConfig;
  assertReady(): Promise<void>;
  reserve(address: string): Promise<void>;
  review(input: {
    descriptor: DirectSessionDescriptor;
    plan: DirectFeePlan;
    duration: number;
    priorityFee: bigint;
    mediaMode?: "audio" | "video";
    visibility?: "public" | "unlisted";
  }): Promise<{ fundingMaxFee: bigint; fundingTip: bigint }>;
  freeze(): Promise<void>;
}

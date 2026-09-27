import type { DirectSessionDescriptor } from "./direct-hoodi";

export const HOODI_BETA_RPC = "/api/hoodi-beta";
export interface HoodiBetaContext {
  descriptor?: DirectSessionDescriptor;
  address?: string;
  /** Hashes of locally signed, plan-checked empty seals; no raw bytes. */
  sealHashes?: `0x${string}`[];
  plan?: {
    duration: number;
    base: string;
    tip: string;
    funding: string;
    mediaMode?: "audio" | "video";
  };
}

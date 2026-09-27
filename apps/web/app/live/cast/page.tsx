import type { Metadata } from "next";

import { HoodiBetaCast } from "../../../components/hoodi-beta-cast";
import { patioNetworkRuntimeConfigs } from "../../../lib/network-runtime";

export const metadata: Metadata = { title: "Cast" };

export default function CastPage() {
  return (
    <main className="simple-page">
      <HoodiBetaCast networkConfigs={patioNetworkRuntimeConfigs()} />
    </main>
  );
}

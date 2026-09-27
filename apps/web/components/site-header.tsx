import Link from "next/link";

import { patioNetworkRuntimeConfigs } from "../lib/network-runtime";
import { LiveGasIndicator } from "./live-gas-indicator";
import { WalletChip } from "./wallet-chip";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="wordmark" aria-label="Patio Tokyo">
        <span className="wordmark__patio" data-text="Patio">
          <span className="wordmark__fill">Patio</span>
        </span>
        <span className="wordmark__station" data-text="Tokyo">
          <span className="wordmark__fill">Tokyo</span>
        </span>
      </Link>
      <div className="site-header__end">
        <nav aria-label="Primary navigation">
          <Link href="/live">Listen</Link>
          <Link href="/live/cast">Broadcast</Link>
        </nav>
        <div className="header-status-pills">
          <LiveGasIndicator networkConfigs={patioNetworkRuntimeConfigs()} />
          <WalletChip />
        </div>
      </div>
    </header>
  );
}

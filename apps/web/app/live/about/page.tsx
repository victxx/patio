import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Protocol" };

export default function AboutPage() {
  return (
    <main className="simple-page">
      <section className="simple-card about-card">
        <span className="simple-status">Experiment</span>
        <h1>About</h1>
        <p>
          Patio is rebuilding an ETHDenver 2024 experiment for sending live
          audio through Ethereum&apos;s pending transaction pool.
        </p>
        <p>
          The simple Hoodi mode runs in two browser tabs. Cast signs replacement
          transactions with an ephemeral session wallet and sends them directly
          to one provider. Listen reconstructs packets seen by a second
          provider.
        </p>
        <p>
          It is intentionally testnet-only: keep the Cast tab open until cleanup
          finishes. Ethereum Mainnet and the hardened relay remain disabled.
        </p>
        <Link href="https://github.com/antron3000/patio">
          Original project and team ↗
        </Link>
      </section>
    </main>
  );
}

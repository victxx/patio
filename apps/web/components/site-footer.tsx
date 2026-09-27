"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

type FooterPanel = "about" | "how" | "legal" | null;

const INFORMATION_BACKDROP_STYLE = {
  backdropFilter: "blur(1.5px) saturate(104%)",
  WebkitBackdropFilter: "blur(1.5px) saturate(104%)",
} satisfies CSSProperties;

const INFORMATION_GLASS_STYLE = {
  backdropFilter: "blur(7px) saturate(108%)",
  WebkitBackdropFilter: "blur(7px) saturate(108%)",
} satisfies CSSProperties;

export function SiteFooter() {
  const [panel, setPanel] = useState<FooterPanel>(null);

  useEffect(() => {
    if (!panel) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [panel]);

  return (
    <>
      <footer className="site-footer">
        <span>Beta · Hoodi</span>
        <div className="site-footer__links">
          <button type="button" onClick={() => setPanel("how")}>
            How it works
          </button>
          <button type="button" onClick={() => setPanel("about")}>
            About
          </button>
          <button type="button" onClick={() => setPanel("legal")}>
            Disclaimer
          </button>
        </div>
      </footer>

      {panel ? (
        <div
          className="footer-modal-backdrop"
          role="presentation"
          style={INFORMATION_BACKDROP_STYLE}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <section
            className="footer-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="footer-modal-title"
            style={INFORMATION_GLASS_STYLE}
          >
            <header className="footer-modal__header">
              <h2 id="footer-modal-title">
                {panel === "how"
                  ? "How it works"
                  : panel === "legal"
                    ? "Disclaimer"
                    : "About Patio"}
              </h2>
              <button
                type="button"
                aria-label="Close information"
                onClick={() => setPanel(null)}
              >
                ×
              </button>
            </header>

            {panel === "how" ? (
              <div className="footer-modal__copy">
                <p>
                  Patio encodes live audio or tiny video into replacement
                  transactions on the selected network. The listener observes
                  pending transactions and rebuilds the stream. The Hoodi beta
                  uses the same service for sending and observation; this is not
                  a claim of independent-node propagation.
                </p>
                <p>
                  Session keys remain in browser memory. Signed media
                  transactions are submitted to the network; their bytes are
                  public and may be recorded or included onchain.
                </p>
              </div>
            ) : panel === "legal" ? (
              <div className="footer-modal__copy">
                <p>
                  Patio is an experimental research project exploring
                  censorship-resistant live media transport through
                  Ethereum&apos;s public mempool. It is not a production
                  communications service, an emergency channel, or a guarantee
                  of availability, privacy, permanence, or anonymity.
                </p>
                <p>
                  Patio uses the Hoodi test network. Broadcasts may fail,
                  disappear, arrive incomplete, expose public wallet activity,
                  be included onchain, or leave test ETH held while cleanup
                  remains unresolved. Users remain responsible for their
                  content, wallet approvals, and compliance with applicable law.
                </p>
                <p>
                  Mainnet broadcasting remains disabled on Ethereum and Gnosis.
                  Patio is independent and is not affiliated with or endorsed by
                  the Ethereum Foundation or Gnosis. It is built in support of
                  open, permissionless infrastructure.
                </p>
              </div>
            ) : (
              <div className="footer-modal__copy">
                <p>
                  Patio is back to explore browser-native broadcasting with
                  modern Ethereum tooling. This version was rebuilt by Victor
                  del Val at{" "}
                  <a
                    href="https://victorxva.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    victorxva.com
                  </a>
                  .
                </p>
                <p>
                  The original concept belongs to{" "}
                  <a
                    href="https://x.com/ariutokintumi"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ariutokintumi
                  </a>
                  .{" "}
                  <a
                    href="https://x.com/AntoineDeVuyst"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Antoine De Vuyst
                  </a>
                  ,{" "}
                  <a
                    href="https://devfolio.co/@zephyranthes032"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Yongjin Chong
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://victorxva.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    myself
                  </a>{" "}
                  are credited for our work on the ETHDenver 2024 hackathon
                  prototype.
                </p>
                <a
                  className="footer-modal__project"
                  href="https://github.com/antron3000/patio"
                  target="_blank"
                  rel="noreferrer"
                >
                  Original GitHub repository ↗
                </a>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}

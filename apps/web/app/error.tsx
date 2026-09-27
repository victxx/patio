"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <p className="eyebrow">Signal failure</p>
      <h1>The receiver lost its carrier.</h1>
      <button type="button" onClick={reset}>
        Retune
      </button>
    </main>
  );
}

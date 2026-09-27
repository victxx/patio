import Link from "next/link";

export default function NotFound() {
  return (
    <main className="error-page">
      <p className="eyebrow">404 / no carrier</p>
      <h1>This frequency is empty.</h1>
      <Link href="/live">Return to Patio</Link>
    </main>
  );
}

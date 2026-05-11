import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>Operations Hub</h1>
      <nav aria-label="Primary navigation">
        <Link href="/">Home</Link>
        <Link href="/customers">Customers</Link>
      </nav>
      <section aria-label="Incident Queue">
        <h2>Incident Queue</h2>
        <article>
          <h3>Payments Latency</h3>
          <p>Severity: High</p>
          <p>Owner: Platform Response</p>
        </article>
        <article>
          <h3>Search Index Delay</h3>
          <p>Severity: Medium</p>
          <p>Owner: Search Guild</p>
        </article>
      </section>
      <button type="button">Acknowledge Incident</button>
    </main>
  );
}

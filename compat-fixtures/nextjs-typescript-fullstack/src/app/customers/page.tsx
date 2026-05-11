import Link from 'next/link';

export default function CustomersPage() {
  return (
    <main>
      <h1>Customer Portfolio</h1>
      <nav aria-label="Primary navigation">
        <Link href="/">Home</Link>
        <Link href="/customers">Customers</Link>
      </nav>
      <section>
        <h2>Priority Customers</h2>
        <ul>
          <li>Summit Foods - Platinum support</li>
          <li>Metro Health - Renewal due</li>
          <li>Bluebird Energy - Expansion review</li>
        </ul>
      </section>
    </main>
  );
}

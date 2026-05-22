import { Component } from '@angular/core';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  template: `
    <main>
      <h1>Project Health Center</h1>
      <nav aria-label="Primary navigation">
        <a href="/">Dashboard</a>
        <a href="/intake">Delivery Intake</a>
        <a href="/reports">Release Reports</a>
      </nav>
      <section aria-label="Active Delivery Streams">
        <h2>Active Delivery Streams</h2>
        <article>
          <h3>Mobile Checkout Stabilization</h3>
          <p>Sprint Confidence: High</p>
          <p>Risk: Payment retry coverage pending</p>
        </article>
        <article>
          <h3>Enterprise Reporting Refresh</h3>
          <p>Sprint Confidence: Medium</p>
          <p>Risk: Data export validation pending</p>
        </article>
      </section>
      <button type="button" aria-label="Review delivery risks">Review Risks</button>
    </main>
  `
})
export class DashboardComponent {}

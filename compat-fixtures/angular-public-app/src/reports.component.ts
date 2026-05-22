import { Component } from '@angular/core';

@Component({
  selector: 'app-reports',
  standalone: true,
  template: `
    <main>
      <h1>Release Reports</h1>
      <nav aria-label="Primary navigation">
        <a href="/">Dashboard</a>
        <a href="/intake">Delivery Intake</a>
      </nav>
      <section>
        <h2>Release Readiness</h2>
        <p>Regression Coverage: 82 percent</p>
        <p>Blocked Stories: 2</p>
        <button type="button">Export Report</button>
      </section>
    </main>
  `
})
export class ReportsComponent {}

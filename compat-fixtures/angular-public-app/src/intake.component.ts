import { Component } from '@angular/core';

@Component({
  selector: 'app-intake',
  standalone: true,
  template: `
    <main>
      <h1>Delivery Intake</h1>
      <nav aria-label="Primary navigation">
        <a href="/">Dashboard</a>
        <a href="/reports">Release Reports</a>
      </nav>
      <form aria-label="Delivery intake form">
        <label for="workstream-name">Workstream Name</label>
        <input id="workstream-name" name="workstreamName" required placeholder="Payments QA" />
        <label for="owner-email">Owner Email</label>
        <input id="owner-email" name="ownerEmail" type="email" required placeholder="owner@example.com" />
        <label for="priority">Priority</label>
        <select id="priority" name="priority">
          <option>High</option>
          <option>Medium</option>
          <option>Low</option>
        </select>
        <button type="submit">Save Intake</button>
      </form>
      <p role="status">Intake Saved</p>
    </main>
  `
})
export class IntakeComponent {}

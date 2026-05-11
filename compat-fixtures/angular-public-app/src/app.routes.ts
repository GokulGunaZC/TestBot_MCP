import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { IntakeComponent } from './intake.component';
import { ReportsComponent } from './reports.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent, title: 'Project Health Center' },
  { path: 'intake', component: IntakeComponent, title: 'Delivery Intake' },
  { path: 'reports', component: ReportsComponent, title: 'Release Reports' }
];

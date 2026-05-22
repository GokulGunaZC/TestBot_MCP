import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { routes } from './app.routes';

bootstrapApplication(DashboardComponent, {
  providers: [provideRouter(routes)]
});

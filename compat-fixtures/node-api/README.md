# Node.js Fulfillment API

This fixture is a backend-only Node.js API for fulfillment work orders.

Acceptance criteria:
- GET `/api/health` returns ok.
- GET `/api/work-orders` returns Packaging Line Calibration.
- POST `/api/work-orders` creates a work order when title and priority are provided.
- POST `/api/work-orders` returns a validation error when title is missing.
- DELETE `/api/work-orders/wo-100` returns a deleted status.

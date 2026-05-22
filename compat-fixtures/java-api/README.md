# Java Inventory API

This fixture is a Java/Spring-style inventory API. Source files use Spring mapping annotations so Healix can detect backend endpoints. Runtime execution uses the included Node server to keep the local compatibility matrix deterministic.

Acceptance criteria:
- GET `/api/inventory` returns Surgical Mask Kit.
- POST `/api/inventory` creates inventory when sku and quantity are provided.
- POST `/api/inventory` returns a validation error when sku is missing.
- GET `/api/inventory/sku-100` returns one inventory item.

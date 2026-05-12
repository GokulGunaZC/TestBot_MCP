# Pulseboard Planted Bugs Fixture

Small source-only fixture for QA-contract extraction regressions:

- `BUG-A`: `GET /api/cards?status=` declares a status filter but returns unfiltered rows.
- `BUG-B`: the board form has required fields but no accessible inline validation.
- `BUG-C`: `DELETE /api/cards/:id` returns no body with `200`; Healix reports this as a confirmation advisory unless source/PRD explicitly requires `204`.


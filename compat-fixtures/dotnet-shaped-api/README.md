# .NET-Shaped Claims API

This fixture mirrors an ASP.NET Core claims API. The local compatibility matrix runs the included Node server because the local machine does not have the `dotnet` CLI. The `.cs` files provide ASP.NET-style endpoint source context for detection and grounding checks.

Acceptance criteria:
- GET `/api/claims` returns Orthopedic Review.
- POST `/api/claims` creates a claim when claimId and member are provided.
- POST `/api/claims` returns a validation error when claimId is missing.
- GET `/api/claims/clm-100` returns one claim.

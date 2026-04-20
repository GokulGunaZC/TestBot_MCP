This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Inngest (async test generation)

Phase 2 of test generation runs per-agent fan-out through [Inngest](https://www.inngest.com/) background functions. This is gated behind `HEALIX_GEN_ASYNC=true`; when off, `/api/generate-tests` stays on the sync Phase-1 path.

### Required env vars

| Variable | Description |
|----------|-------------|
| `INNGEST_EVENT_KEY` | Event key from the Inngest dashboard. Used when sending events from Next.js routes. |
| `INNGEST_SIGNING_KEY` | Webhook signing key. Inngest signs webhook requests; the serve route at `/api/inngest` verifies them. |
| `HEALIX_GEN_ASYNC` | Webapp-side flag. `true` routes `/api/generate-tests` through Inngest; `false` keeps the sync path. |
| `INNGEST_DEV` | Set to `1` only when running against the local `inngest-cli`. |

### Local dev

```bash
pnpm dlx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

The CLI auto-discovers registered functions (`generate-tests-orchestrator`, `generate-tests-agent`) and streams event runs in its UI.

### Production linkage

Link the Vercel deployment to Inngest via the Inngest Vercel integration. After install, verify:

- `/api/inngest` returns a 200 with the function registry on GET.
- Webhook signature validation succeeds (check Inngest dashboard → deliveries).
- Both `generate-tests-orchestrator` and `generate-tests-agent` appear in the Inngest function list.

### Cost

Inngest free tier = 25k function runs/month. Each generation job emits 1 orchestrator + up to 5 agent runs (= 6 runs per job). At 100 jobs/day that's ~18k runs/month — comfortably under free tier.

### Troubleshooting

- `inngest.send` failure → `/api/generate-tests` falls back to the sync path automatically. Users still get tests, just slower.
- Missing 202 response → check `HEALIX_GEN_ASYNC` is actually `true` on the Vercel env for the deployed branch.
- Stuck poll → inspect the `generation_jobs` row (`SELECT * FROM generation_jobs WHERE id = ?`) and the matching Inngest run.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

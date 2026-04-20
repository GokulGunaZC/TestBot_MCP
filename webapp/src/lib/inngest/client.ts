import { Inngest } from 'inngest';

// Module-level singleton; safe across hot-reloads because Next.js caches module instances.
export const inngest = new Inngest({
  id: 'healix-webapp',
  // Production reads INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY from env automatically.
  // Local dev via `inngest-cli dev` connects over HTTP without signing.
});

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { generateTestsAgent } from '@/lib/inngest/functions/generate-tests-agent';
import { generateTestsOrchestrator } from '@/lib/inngest/functions/generate-tests-orchestrator';

export const runtime = 'nodejs';     // Inngest SDK needs Node, not Edge
export const maxDuration = 60;       // Hobby-safe; Inngest chunks per step anyway
export const dynamic = 'force-dynamic';

// Registered Inngest functions for this app. The orchestrator fans `generation/
// job.requested` events out per-agent and waits for each to complete; the
// per-agent worker consumes `generation/agent.requested` and emits
// `generation/agent.completed` back.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateTestsAgent, generateTestsOrchestrator],
});

import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Produces a self-contained server at .next/standalone — used by the
  // Docker runner stage so we ship compiled JS only, no TypeScript source.
  output: 'standalone',
  // Trace files from the monorepo root, not the webapp/ subdir, so the
  // standalone server bundles shared workspace files correctly.
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  // Never ship source maps to clients — they de-obfuscate the bundle.
  productionBrowserSourceMaps: false,
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  allowedDevOrigins: [
    'http://127.0.0.1',
    'http://localhost',
  ],
  experimental: {
    // Vercel Hobby hard-caps API request bodies at 4.5 MB, Pro is
    // configurable but 25 MB is a safer ceiling than 300 MB. Large artifacts
    // (videos, traces) should go direct to Supabase Storage via signed URLs,
    // NOT through the Next.js handler.
    serverActions: {
      bodySizeLimit: '25mb',
    },
    proxyClientMaxBodySize: '25mb',
  },
};

export default nextConfig;

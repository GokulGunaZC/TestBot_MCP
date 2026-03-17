import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  allowedDevOrigins: [
    'http://127.0.0.1',
    'http://localhost',
  ],
};

export default nextConfig;

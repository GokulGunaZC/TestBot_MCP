#!/usr/bin/env node
const HealixMCPServer = require('../src/index.js');

const server = new HealixMCPServer();
server.start().catch((err) => {
  console.error('[healix-mcp] failed to start:', err);
  process.exit(1);
});

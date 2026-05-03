#!/usr/bin/env node
// Compatibility entrypoint: recommend MCP async control now runs through the
// shared CDP-only recommend service instead of the legacy detached worker.
await import("./test-recommend-mcp.js");

#!/usr/bin/env node

/**
 * nx-ce — Claude Engine (v0.2 serve-only)
 *
 * Single entry point — all consumers (CLI / Chrome extension / native_host)
 * talk to the WebSocket server via the unified protocol.
 *
 *   nx-ce serve [--port 43720]  — start WebSocket server
 *   nx-ce status                — list instance states
 *   nx-ce help                  — show help
 */

import { runCli } from '../src/cli/commands.js';

runCli()
  .then((result) => {
    if (result) {
      console.log(JSON.stringify(result));
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

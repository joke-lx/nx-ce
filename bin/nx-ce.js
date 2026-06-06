#!/usr/bin/env node

/**
 * nx-ce — Claude Engine
 *
 * CLI entry point. Routes to subcommands:
 *   nx-ce query "prompt"    — one-shot cold-start query
 *   nx-ce serve             — persistent manager process (stdin/stdout protocol)
 *   nx-ce status            — show instance state
 */

import { runCli } from '../src/cli.js';

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

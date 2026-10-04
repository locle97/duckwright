#!/usr/bin/env node
import { main } from "./cli.ts";

// The first Ctrl-C stops the run cleanly: the running child is killed, history.json is
// written and the browser is closed. A second one exits at once.
const controller = new AbortController();
process.on("SIGINT", () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });

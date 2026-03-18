#!/usr/bin/env node

console.log("[START] Starting wrapper...");
console.log("[START] Node:", process.version);
console.log("[START] CWD:", process.cwd());
console.log("[START] PORT:", process.env.PORT);

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("[START] Spawning tsx...");

const child = spawn("npx", ["tsx", "admin-server.ts"], {
  cwd: __dirname,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error("[START] Failed to spawn:", err);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log("[START] Child exited with code:", code);
  process.exit(code || 0);
});

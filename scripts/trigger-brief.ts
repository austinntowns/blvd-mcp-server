/**
 * Manually trigger the daily brief with Railway env vars.
 *
 * Uses `railway run` to inject all Railway env vars (BLVD keys, GitHub token,
 * Pronto token, GCP creds) then executes the brief script locally.
 *
 * Usage:  npm run brief:trigger
 *         npm run brief:trigger -- 2026-03-15   # specific date
 */
import { execSync } from "child_process";

const dateArg = process.argv[2] ? ` ${process.argv[2]}` : "";
const cmd = `railway run npx tsx scripts/daily-brief-v4.ts${dateArg}`;

console.log(`⏳ Running: ${cmd}\n`);

try {
  execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
} catch {
  process.exit(1);
}

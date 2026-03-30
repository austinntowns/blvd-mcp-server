/**
 * Manually trigger the daily-brief-cron service on Railway.
 *
 * Reads the Railway token from ~/.railway/config.json (set by `railway login`).
 * Usage:  npx tsx scripts/trigger-brief.ts          # trigger + stream logs
 *         npx tsx scripts/trigger-brief.ts --no-logs # trigger only
 */
import fs from "fs";
import path from "path";
import os from "os";

const SERVICE_ID = "7489d4c7-c601-4d3c-a219-56068aa00cb4";
const ENV_ID = "6ef3099a-f88a-4eb5-b614-90b80fdecf96";
const API = "https://backboard.railway.app/graphql/v2";

function getRailwayToken(): string {
  const configPath = path.join(os.homedir(), ".railway/config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const token = config?.user?.token;
  if (!token) throw new Error("No Railway token found. Run `railway login` first.");
  return token;
}

async function gql(token: string, query: string): Promise<Record<string, unknown>> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data!;
}

async function waitForExecution(token: string, afterId: string): Promise<string | null> {
  // Poll for a new deployment (execution) that appears after the current latest
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const data = await gql(
      token,
      `query { deployments(first: 3, input: { serviceId: "${SERVICE_ID}", environmentId: "${ENV_ID}" }) { edges { node { id status createdAt } } } }`
    );
    const edges = (data.deployments as { edges: Array<{ node: { id: string; status: string } }> }).edges;
    const latest = edges[0]?.node;
    if (!latest) continue;

    // Look for an execution (not a build) that appeared after our trigger
    if (latest.id !== afterId) {
      if (latest.status === "SUCCESS") {
        return latest.id;
      } else if (latest.status === "CRASHED" || latest.status === "FAILED") {
        return latest.id;
      }
      // Still running, keep polling
      process.stdout.write(".");
    } else {
      process.stdout.write(".");
    }
  }
  return null;
}

async function getDeployLogs(token: string, deployId: string): Promise<string> {
  const data = await gql(
    token,
    `query { deploymentLogs(deploymentId: "${deployId}", filter: "deploy") { message timestamp } }`
  );
  const logs = data.deploymentLogs as Array<{ message: string; timestamp: string }> | null;
  if (!logs?.length) return "(no logs captured)";
  return logs.map((l) => l.message).join("\n");
}

async function main() {
  const showLogs = !process.argv.includes("--no-logs");
  const token = getRailwayToken();

  // Get current latest deployment ID so we can detect a new one
  const before = await gql(
    token,
    `query { deployments(first: 1, input: { serviceId: "${SERVICE_ID}", environmentId: "${ENV_ID}" }) { edges { node { id } } } }`
  );
  const currentId =
    (before.deployments as { edges: Array<{ node: { id: string } }> }).edges[0]?.node.id ?? "";

  // Trigger redeploy (for cron services this runs the command immediately)
  console.log("⏳ Triggering daily brief on Railway...");
  await gql(
    token,
    `mutation { serviceInstanceRedeploy(serviceId: "${SERVICE_ID}", environmentId: "${ENV_ID}") }`
  );
  console.log("✅ Triggered. Waiting for execution...");

  const execId = await waitForExecution(token, currentId);
  if (!execId) {
    console.error("⏰ Timed out waiting for execution (5 min). Check Railway dashboard.");
    process.exit(1);
  }

  // Check status
  const statusData = await gql(
    token,
    `query { deployments(first: 1, input: { serviceId: "${SERVICE_ID}", environmentId: "${ENV_ID}" }) { edges { node { id status } } } }`
  );
  const status = (statusData.deployments as { edges: Array<{ node: { status: string } }> }).edges[0]?.node.status;
  console.log(`\n🏁 Execution ${status}`);

  if (showLogs) {
    console.log("\n--- Logs ---");
    const logs = await getDeployLogs(token, execId);
    console.log(logs);
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});

import "dotenv/config";
import { listWebhooks, createWebhook, deleteWebhook } from "../lib/boulevard.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    console.log("Listing webhooks...");
    try {
      const webhooks = await listWebhooks();
      console.log(`Found ${webhooks.length} webhooks`);
      for (const wh of webhooks) {
        console.log(`\n${wh.name}`);
        console.log(`  ID: ${wh.id}`);
        console.log(`  URL: ${wh.url}`);
        console.log(`  Events: ${wh.subscriptions.map(s => s.eventType).join(", ")}`);
      }
    } catch (e: any) {
      console.error("Error:", e.message);
    }
    return;
  }

  const url = args[0];
  const locationId = args[1];

  if (!url || !locationId) {
    console.log("Usage:");
    console.log("  npx tsx scripts/test-webhook-api.ts --list");
    console.log("  npx tsx scripts/test-webhook-api.ts <url> <locationId>");
    return;
  }

  console.log(`Creating webhook for location ${locationId}...`);
  try {
    const webhook = await createWebhook(locationId, url, "BTB Test Webhook");
    console.log("Created webhook:", webhook.id);
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

main().catch(console.error);

/**
 * Setup Boulevard Webhooks
 *
 * Creates webhooks for all enrolled locations pointing to the BTB admin server.
 *
 * Usage:
 *   npx tsx scripts/setup-webhooks.ts <webhook-url>
 *   npx tsx scripts/setup-webhooks.ts https://your-domain.com/webhook/boulevard
 *   npx tsx scripts/setup-webhooks.ts --list
 *   npx tsx scripts/setup-webhooks.ts --delete-all
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  listWebhooks,
  createWebhook,
  deleteWebhook,
  getLocations,
} from "../lib/boulevard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getEnrolledLocations(): string[] {
  const enrollmentFile = join(__dirname, "..", "enrolled-locations.json");
  try {
    if (existsSync(enrollmentFile)) {
      const data = JSON.parse(readFileSync(enrollmentFile, "utf-8"));
      return data.locations || [];
    }
  } catch (e) {
    console.error("Error reading enrollment file:", e);
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    console.log("Listing existing webhooks...\n");
    const webhooks = await listWebhooks();
    if (webhooks.length === 0) {
      console.log("No webhooks configured.");
    } else {
      for (const wh of webhooks) {
        console.log(`${wh.name}`);
        console.log(`  ID: ${wh.id}`);
        console.log(`  URL: ${wh.url}`);
        console.log(`  Events: ${wh.subscriptions.map(s => s.eventType).join(", ")}`);
        console.log();
      }
    }
    return;
  }

  if (args.includes("--delete-all")) {
    console.log("Deleting all webhooks...\n");
    const webhooks = await listWebhooks();
    for (const wh of webhooks) {
      console.log(`Deleting: ${wh.name} (${wh.id})`);
      await deleteWebhook(wh.id);
    }
    console.log(`\nDeleted ${webhooks.length} webhooks.`);
    return;
  }

  const webhookUrl = args[0];
  if (!webhookUrl) {
    console.log("Usage:");
    console.log("  npx tsx scripts/setup-webhooks.ts <webhook-url>  # Create webhooks");
    console.log("  npx tsx scripts/setup-webhooks.ts --list         # List webhooks");
    console.log("  npx tsx scripts/setup-webhooks.ts --delete-all   # Delete all webhooks");
    console.log();
    console.log("Example:");
    console.log("  npx tsx scripts/setup-webhooks.ts https://your-domain.com/webhook/boulevard");
    process.exit(1);
  }

  if (!webhookUrl.startsWith("https://")) {
    console.error("Error: Webhook URL must use HTTPS");
    process.exit(1);
  }

  const enrolledLocations = getEnrolledLocations();
  if (enrolledLocations.length === 0) {
    console.log("No enrolled locations found. Enroll locations via the admin UI first.");
    process.exit(1);
  }

  // Get location names for better webhook naming
  const allLocations = await getLocations();
  const locationMap = new Map(allLocations.map(l => [l.id, l.name]));

  console.log(`Creating webhooks for ${enrolledLocations.length} enrolled locations...`);
  console.log(`URL: ${webhookUrl}\n`);

  let created = 0;
  let errors = 0;

  for (const locationId of enrolledLocations) {
    const locationName = locationMap.get(locationId) || locationId.replace("urn:blvd:Location:", "").substring(0, 8);
    const webhookName = `BTB Auto-Cleanup: ${locationName}`;

    try {
      const webhook = await createWebhook(locationId, webhookUrl, webhookName);
      console.log(`✓ Created: ${webhookName}`);
      console.log(`  ID: ${webhook.id}`);
      created++;
    } catch (e: any) {
      console.log(`✗ Failed: ${webhookName}`);
      console.log(`  Error: ${e.message?.substring(0, 100)}`);
      errors++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Created: ${created}`);
  if (errors > 0) console.log(`Errors: ${errors}`);
}

main().catch(console.error);

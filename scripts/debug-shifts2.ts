import "dotenv/config";
import {
  getLocations,
  getStaff,
} from "../lib/boulevard.js";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";

const BLVD_API_URL = process.env.BLVD_API_URL || "https://dashboard.boulevard.io/api/2020-01/admin";

function generateAuthHeader(): string {
  const apiKey = process.env.BLVD_API_KEY;
  const apiSecret = process.env.BLVD_API_SECRET;
  const businessId = process.env.BLVD_BUSINESS_ID;

  if (!apiKey || !apiSecret || !businessId) {
    throw new Error("Missing Boulevard credentials");
  }

  const prefix = "blvd-admin-v1";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;

  const rawKey = Buffer.from(apiSecret, "base64");
  const signature = crypto.createHmac("sha256", rawKey).update(payload, "utf8").digest("base64");

  const token = `${signature}${payload}`;
  const httpBasicPayload = `${apiKey}:${token}`;
  const httpBasicCredentials = Buffer.from(httpBasicPayload, "utf8").toString("base64");

  return `Basic ${httpBasicCredentials}`;
}

async function main() {
  const locations = await getLocations();
  const sugarhouse = locations.find((l) => l.name.toLowerCase().includes("sugar house"));

  if (!sugarhouse) {
    console.log("Location not found");
    return;
  }

  console.log("Location:", sugarhouse.name);
  console.log("Location ID:", sugarhouse.id);

  // Get staff for this location
  const staff = await getStaff(sugarhouse.id);
  console.log("\n=== STAFF AT LOCATION ===");
  console.log(`Found ${staff.length} staff members`);
  for (const s of staff.slice(0, 5)) {
    console.log(`${s.name} (ID: ${s.id})`);
  }

  // Also get raw shifts to see staff IDs
  const client = new GraphQLClient(BLVD_API_URL, {
    headers: {
      Authorization: generateAuthHeader(),
    },
  });

  const query = gql`
    query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
      shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
        shifts {
          staffId
          clockIn
          clockOut
          day
        }
      }
    }
  `;

  const result = await client.request(query, {
    locationId: sugarhouse.id,
    startIso8601: "2026-03-23",
    endIso8601: "2026-03-23",
  }) as any;

  console.log("\n=== RAW SHIFT DATA ===");
  for (const shift of result.shifts.shifts) {
    console.log(`Staff ID: ${shift.staffId}, Day: ${shift.day}, ${shift.clockIn}-${shift.clockOut}`);
  }
}

main().catch(console.error);

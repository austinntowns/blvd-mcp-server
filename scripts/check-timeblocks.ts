import "dotenv/config";
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
  const client = new GraphQLClient(BLVD_API_URL, {
    headers: {
      Authorization: generateAuthHeader(),
    },
  });

  const locationId = "urn:blvd:Location:1d546022-4d3d-4f0f-9414-321e6251b595";
  const targetDate = "2026-03-23";

  const query = gql`
    query GetTimeblocks($locationId: ID!) {
      timeblocks(locationId: $locationId, first: 100) {
        edges {
          node {
            id
            startAt
            endAt
            title
            staff {
              name
            }
          }
        }
      }
    }
  `;

  const result = await client.request(query, { locationId }) as any;

  console.log(`Timeblocks on ${targetDate}:`);
  for (const edge of result.timeblocks.edges) {
    const tb = edge.node;
    if (tb.startAt.includes(targetDate)) {
      const isBTB = tb.title?.toLowerCase().includes("btb") ? "✓ BTB" : "";
      console.log(`  ${tb.staff?.name}: ${tb.startAt} - "${tb.title}" ${isBTB}`);
      console.log(`    ID: ${tb.id}`);
    }
  }

  // Check if the deleted IDs still exist
  const deletedIds = [
    "urn:blvd:Timeblock:501ac1e9-8035-46cd-af78-5872b743ada0",
    "urn:blvd:Timeblock:2a736608-494f-4cfa-990e-523882cc3a3b"
  ];

  console.log("\nChecking deleted blocks:");
  for (const id of deletedIds) {
    const found = result.timeblocks.edges.find((e: any) => e.node.id === id);
    console.log(`  ${id}: ${found ? "STILL EXISTS" : "DELETED"}`);
  }
}

main().catch(console.error);

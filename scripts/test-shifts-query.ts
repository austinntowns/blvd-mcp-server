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
  const startDate = "2026-03-23";
  const endDate = "2026-03-23";

  // Try with the StaffShift fields we know exist
  const query = gql`
    query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
      shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
        shifts {
          staffId
          locationId
          clockIn
          clockOut
          available
          day
          recurrence
          recurrenceStart
          recurrenceEnd
        }
      }
    }
  `;

  try {
    const result = await client.request(query, {
      locationId,
      startIso8601: startDate,
      endIso8601: endDate,
    });
    console.log("Shifts result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

main().catch(console.error);

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

  const timeblockId = "urn:blvd:Timeblock:501ac1e9-8035-46cd-af78-5872b743ada0";

  console.log(`Attempting to delete timeblock: ${timeblockId}\n`);

  const mutation = gql`
    mutation DeleteTimeblock($input: DeleteTimeblockInput!) {
      deleteTimeblock(input: $input) {
        id
      }
    }
  `;

  try {
    const result = await client.request(mutation, {
      input: { id: timeblockId }
    });
    console.log("Response:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log("Error:", err.message);
    if (err.response) {
      console.log("Response body:", err.response.body);
    }
  }

  // Verify if it still exists
  console.log("\nVerifying...");
  const query = gql`
    query CheckTimeblock($id: ID!) {
      node(id: $id) {
        id
        ... on Timeblock {
          title
          startAt
        }
      }
    }
  `;

  try {
    const check = await client.request(query, { id: timeblockId });
    console.log("Block still exists:", JSON.stringify(check, null, 2));
  } catch (err: any) {
    console.log("Block lookup failed (might mean deleted):", err.message);
  }
}

main().catch(console.error);

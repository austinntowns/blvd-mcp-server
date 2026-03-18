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

  // First introspect the Timeblock type to see all fields
  const introspect = gql`
    query IntrospectTimeblock {
      __type(name: "Timeblock") {
        name
        fields {
          name
          type {
            name
            kind
          }
        }
      }
    }
  `;

  const schema = await client.request(introspect);
  console.log("Timeblock fields:");
  console.log(JSON.stringify(schema, null, 2));

  // Get full details of the timeblock
  const timeblockId = "urn:blvd:Timeblock:501ac1e9-8035-46cd-af78-5872b743ada0";

  const query = gql`
    query GetTimeblock($id: ID!) {
      node(id: $id) {
        id
        ... on Timeblock {
          title
          startAt
          endAt
          duration
          reason
        }
      }
    }
  `;

  const result = await client.request(query, { id: timeblockId });
  console.log("\nTimeblock details:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);

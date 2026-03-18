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

  // Check the cancelled field of both timeblocks
  const timeblockIds = [
    "urn:blvd:Timeblock:501ac1e9-8035-46cd-af78-5872b743ada0",
    "urn:blvd:Timeblock:2a736608-494f-4cfa-990e-523882cc3a3b"
  ];

  for (const id of timeblockIds) {
    const query = gql`
      query GetTimeblock($id: ID!) {
        node(id: $id) {
          id
          ... on Timeblock {
            title
            startAt
            endAt
            cancelled
            reason
          }
        }
      }
    `;

    const result = await client.request(query, { id });
    console.log(`Timeblock ${id.split(":").pop()}:`);
    console.log(JSON.stringify(result, null, 2));
    console.log();
  }

  // Introspect DeleteTimeblockInput
  const introspect = gql`
    query IntrospectDeleteInput {
      __type(name: "DeleteTimeblockInput") {
        name
        inputFields {
          name
          type {
            name
            kind
            ofType {
              name
              kind
            }
          }
        }
      }
    }
  `;

  const schema = await client.request(introspect);
  console.log("DeleteTimeblockInput fields:");
  console.log(JSON.stringify(schema, null, 2));
}

main().catch(console.error);

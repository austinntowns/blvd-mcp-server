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

  // Introspect the Shift type
  const query = gql`
    query IntrospectShift {
      __type(name: "Shift") {
        name
        fields {
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

  const result = await client.request(query);
  console.log("Shift type fields:");
  console.log(JSON.stringify(result, null, 2));

  // Try to find a query that returns Shift types
  const query2 = gql`
    query FindShiftQueries {
      __schema {
        queryType {
          fields(includeDeprecated: true) {
            name
            type {
              name
              kind
              ofType {
                name
              }
            }
            args {
              name
              type {
                name
                kind
              }
            }
          }
        }
      }
    }
  `;

  const result2 = await client.request(query2);
  const shiftQueries = (result2 as any).__schema.queryType.fields.filter(
    (f: any) =>
      f.name.toLowerCase().includes("shift") ||
      f.name.toLowerCase().includes("schedule") ||
      f.type?.name?.toLowerCase()?.includes("shift") ||
      f.type?.ofType?.name?.toLowerCase()?.includes("shift")
  );
  console.log("\nShift-related queries:");
  console.log(JSON.stringify(shiftQueries, null, 2));
}

main().catch(console.error);

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

  // Find staff-related queries
  const query = gql`
    query FindStaffQueries {
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

  const result = await client.request(query);
  const staffQueries = (result as any).__schema.queryType.fields.filter(
    (f: any) =>
      f.name.toLowerCase().includes("staff") ||
      f.type?.name?.toLowerCase()?.includes("staff") ||
      f.type?.ofType?.name?.toLowerCase()?.includes("staff")
  );
  console.log("Staff-related queries:");
  console.log(JSON.stringify(staffQueries, null, 2));

  // Also check Staff type
  const query2 = gql`
    query IntrospectStaff {
      __type(name: "Staff") {
        name
        fields {
          name
          type {
            name
            kind
            ofType {
              name
            }
          }
        }
      }
    }
  `;

  const result2 = await client.request(query2);
  console.log("\nStaff type fields:");
  console.log(JSON.stringify(result2, null, 2));
}

main().catch(console.error);

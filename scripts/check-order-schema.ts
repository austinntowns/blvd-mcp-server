import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";

const BLVD_API_URL = "https://dashboard.boulevard.io/api/2020-01/admin";

function generateAuthHeader(): string {
  const apiKey = process.env.BLVD_API_KEY!;
  const apiSecret = process.env.BLVD_API_SECRET!;
  const businessId = process.env.BLVD_BUSINESS_ID!;
  const prefix = "blvd-admin-v1";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, "base64");
  const signature = crypto.createHmac("sha256", rawKey).update(payload, "utf8").digest("base64");
  const token = `${signature}${payload}`;
  return `Basic ${Buffer.from(`${apiKey}:${token}`, "utf8").toString("base64")}`;
}

const client = new GraphQLClient(BLVD_API_URL, {
  headers: { Authorization: generateAuthHeader() },
});

async function main() {
  // Check OrderLineGroup
  const groupQuery = gql`
    query {
      __type(name: "OrderLineGroup") {
        fields { name type { name kind ofType { name } } }
      }
    }
  `;
  console.log("=== ORDER LINE GROUP ===");
  const groupData = await client.request(groupQuery);
  console.log(JSON.stringify((groupData as any).__type?.fields, null, 2));

  // Check OrderLine
  const lineQuery = gql`
    query {
      __type(name: "OrderLine") {
        fields { name type { name kind ofType { name } } }
      }
    }
  `;
  console.log("\n=== ORDER LINE ===");
  const lineData = await client.request(lineQuery);
  console.log(JSON.stringify((lineData as any).__type?.fields, null, 2));
}

main().catch(console.error);

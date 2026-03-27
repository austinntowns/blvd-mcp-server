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
  // Check mutations
  const mutationsQuery = gql`
    query {
      __schema {
        mutationType {
          fields {
            name
          }
        }
      }
    }
  `;
  
  console.log("=== REPORT-RELATED MUTATIONS ===\n");
  const mutations: any = await client.request(mutationsQuery);
  for (const f of mutations.__schema.mutationType.fields) {
    if (f.name.toLowerCase().includes('report') || f.name.toLowerCase().includes('export')) {
      console.log(`  ${f.name}`);
    }
  }

  // Get count of locations
  const locationsQuery = gql`
    query { locations(first: 100) { edges { node { id name } } pageInfo { hasNextPage } } }
  `;
  const locations: any = await client.request(locationsQuery);
  console.log(`\n=== LOCATION COUNT ===`);
  console.log(`${locations.locations.edges.length} locations (has more: ${locations.locations.pageInfo.hasNextPage})`);

  // Quick test - get appointment count for one location in last month
  const testQuery = gql`
    query TestCount($locationId: ID!) {
      appointments(locationId: $locationId, first: 1) {
        pageInfo { hasNextPage }
      }
    }
  `;
  const firstLoc = locations.locations.edges[0].node;
  console.log(`\nTest location: ${firstLoc.name}`);
}

main().catch(console.error);

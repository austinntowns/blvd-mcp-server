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

const SERVICES_QUERY = gql`
  query GetServices($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          category { name }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function main() {
  let allServices: any[] = [];
  let hasNext = true;
  let cursor: string | null = null;
  let pageCount = 0;

  console.log("Fetching all services...\n");

  while (hasNext) {
    if (pageCount > 0) await new Promise(r => setTimeout(r, 350));

    const data: any = await client.request(SERVICES_QUERY, { first: 100, after: cursor });
    allServices.push(...data.services.edges.map((e: any) => e.node));
    hasNext = data.services.pageInfo.hasNextPage;
    cursor = data.services.pageInfo.endCursor;
    pageCount++;
  }

  console.log(`Total services: ${allServices.length}\n`);

  // Group by category
  const byCategory = new Map<string, any[]>();
  for (const svc of allServices) {
    const cat = svc.category?.name || "Uncategorized";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(svc);
  }

  // Print by category
  const sortedCategories = [...byCategory.keys()].sort();
  for (const cat of sortedCategories) {
    const services = byCategory.get(cat)!;
    console.log(`\n=== ${cat} (${services.length}) ===`);
    for (const svc of services.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${svc.name}`);
    }
  }
}

main().catch(console.error);

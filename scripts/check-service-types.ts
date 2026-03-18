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
  // Get all services and categorize
  let allServices: any[] = [];
  let hasNext = true;
  let cursor: string | null = null;
  
  while (hasNext) {
    const query = gql`
      query GetServices($first: Int!, $after: String) {
        services(first: $first, after: $after) {
          edges {
            node {
              id
              name
              category { name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const data: any = await client.request(query, { first: 100, after: cursor });
    allServices.push(...data.services.edges.map((e: any) => e.node));
    hasNext = data.services.pageInfo.hasNextPage;
    cursor = data.services.pageInfo.endCursor;
  }
  
  console.log(`Total services: ${allServices.length}\n`);
  
  // Find sugar vs wax services
  const sugarServices = allServices.filter(s => 
    s.name.toLowerCase().includes('sugar') || 
    s.category?.name?.toLowerCase().includes('sugar')
  );
  const waxServices = allServices.filter(s => 
    (s.name.toLowerCase().includes('wax') || s.category?.name?.toLowerCase().includes('wax')) &&
    !s.name.toLowerCase().includes('sugar')
  );
  
  console.log(`=== SUGAR SERVICES (${sugarServices.length}) ===`);
  for (const s of sugarServices.slice(0, 20)) {
    console.log(`  [${s.category?.name || '-'}] ${s.name}`);
  }
  
  console.log(`\n=== WAX SERVICES (${waxServices.length}) ===`);
  for (const s of waxServices.slice(0, 20)) {
    console.log(`  [${s.category?.name || '-'}] ${s.name}`);
  }
  
  // Get unique categories
  const categories = [...new Set(allServices.map(s => s.category?.name).filter(Boolean))];
  console.log(`\n=== ALL CATEGORIES (${categories.length}) ===`);
  console.log(categories.sort().join('\n'));
}

main().catch(console.error);

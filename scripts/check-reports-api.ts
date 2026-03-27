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
  // Check for report-related queries
  const query = gql`
    query {
      __schema {
        queryType {
          fields {
            name
            description
          }
        }
      }
    }
  `;
  
  const data: any = await client.request(query);
  console.log("=== AVAILABLE QUERIES ===\n");
  
  const fields = data.__schema.queryType.fields;
  for (const f of fields.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
    // Look for anything report/analytics related
    const name = f.name.toLowerCase();
    if (name.includes('report') || name.includes('analytic') || name.includes('stat') || 
        name.includes('summary') || name.includes('count') || name.includes('metric')) {
      console.log(`* ${f.name}: ${f.description || '(no description)'}`);
    }
  }
  
  console.log("\n=== ALL QUERIES ===\n");
  for (const f of fields.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
    console.log(`  ${f.name}`);
  }
}

main().catch(console.error);

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
  // Check Money type
  const moneyQuery = gql`
    query {
      __type(name: "Money") {
        fields {
          name
          type { name kind ofType { name } }
        }
      }
    }
  `;
  const moneyData = await client.request(moneyQuery);
  console.log("=== MONEY FIELDS ===");
  console.log(JSON.stringify((moneyData as any).__type?.fields || "Not an object type", null, 2));

  // Check OrderSummary
  const summaryQuery = gql`
    query {
      __type(name: "OrderSummary") {
        fields {
          name
          type { name kind ofType { name } }
        }
      }
    }
  `;
  const summaryData = await client.request(summaryQuery);
  console.log("\n=== ORDER SUMMARY FIELDS ===");
  const summaryFields = (summaryData as any).__type?.fields || [];
  for (const f of summaryFields) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }

  // Get sample services to see naming patterns
  const servicesQuery = gql`
    query {
      services(first: 50) {
        edges {
          node {
            id
            name
            category { name }
          }
        }
      }
    }
  `;
  const servicesData = await client.request(servicesQuery);
  console.log("\n=== SAMPLE SERVICES ===");
  const services = (servicesData as any).services.edges;
  for (const s of services.slice(0, 30)) {
    console.log(`  [${s.node.category?.name || 'No category'}] ${s.node.name}`);
  }
}

main().catch(console.error);

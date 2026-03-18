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
  // Check Membership type
  const membershipQuery = gql`
    query {
      __type(name: "Membership") {
        fields { name type { name kind ofType { name } } }
      }
    }
  `;
  console.log("=== MEMBERSHIP FIELDS ===");
  const data = await client.request(membershipQuery);
  for (const f of (data as any).__type?.fields || []) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }

  // Check MembershipPlan type
  const planQuery = gql`
    query {
      __type(name: "MembershipPlan") {
        fields { name type { name kind ofType { name } } }
      }
    }
  `;
  console.log("\n=== MEMBERSHIP PLAN FIELDS ===");
  const planData = await client.request(planQuery);
  for (const f of (planData as any).__type?.fields || []) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }

  // Check Client type for membership fields
  const clientQuery = gql`
    query {
      __type(name: "Client") {
        fields { name type { name kind ofType { name } } }
      }
    }
  `;
  console.log("\n=== CLIENT FIELDS (looking for membership) ===");
  const clientData = await client.request(clientQuery);
  for (const f of (clientData as any).__type?.fields || []) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    if (f.name.toLowerCase().includes('member')) {
      console.log(`  ${f.name}: ${typeName}`);
    }
  }

  // Get sample membership plans
  const samplePlans = gql`
    query {
      membershipPlans(first: 30) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;
  console.log("\n=== SAMPLE MEMBERSHIP PLANS ===");
  const plansData: any = await client.request(samplePlans);
  for (const edge of plansData.membershipPlans.edges) {
    console.log(`  ${edge.node.name}`);
  }
}

main().catch(console.error);

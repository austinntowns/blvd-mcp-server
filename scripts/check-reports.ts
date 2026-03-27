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
  // List available reports (paginated)
  const reportsQuery = gql`
    query {
      reports(first: 50) {
        edges {
          node {
            id
            name
            templateId
          }
        }
      }
    }
  `;
  console.log("=== AVAILABLE REPORTS ===\n");
  const reports: any = await client.request(reportsQuery);
  for (const edge of reports.reports?.edges || []) {
    const r = edge.node;
    console.log(`${r.name}`);
    console.log(`  ID: ${r.id}`);
    console.log(`  Template: ${r.templateId}\n`);
  }

  // Check reportExport type - this is how you run a report
  const exportTypeQuery = gql`
    query {
      __type(name: "ReportExport") {
        fields { name type { name kind ofType { name } } }
      }
    }
  `;
  console.log("\n=== REPORT EXPORT FIELDS ===");
  const exportType: any = await client.request(exportTypeQuery);
  for (const f of exportType.__type?.fields || []) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }
}

main().catch(console.error);

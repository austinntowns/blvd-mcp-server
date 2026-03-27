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
  // Check the report
  const reportQuery = gql`
    query GetReport($id: ID!) {
      node(id: $id) {
        ... on Report {
          id
          name
          templateId
          availableFilters
        }
      }
    }
  `;
  
  const reportId = "urn:blvd:Report:ed669d02-4dd5-4550-b6a4-0563efdca454";
  console.log("=== SERVICE SALES REPORT ===\n");
  const report: any = await client.request(reportQuery, { id: reportId });
  console.log("Name:", report.node?.name);
  console.log("Template:", report.node?.templateId);
  console.log("Available Filters:", report.node?.availableFilters);

  // Check existing exports
  const exportsQuery = gql`
    query GetReportExports($first: Int!) {
      reportExports(first: $first) {
        edges {
          node {
            id
            fileUrl
            fileContentType
            currentExportAt
            report { name templateId }
          }
        }
      }
    }
  `;
  
  console.log("\n=== RECENT REPORT EXPORTS ===\n");
  const exports: any = await client.request(exportsQuery, { first: 10 });
  for (const edge of exports.reportExports?.edges || []) {
    const e = edge.node;
    console.log(`${e.report?.name || 'Unknown'} (${e.report?.templateId})`);
    console.log(`  Exported: ${e.currentExportAt}`);
    console.log(`  Format: ${e.fileContentType}`);
    console.log(`  URL: ${e.fileUrl ? e.fileUrl.substring(0, 80) + '...' : 'not available'}`);
    console.log();
  }

  // Check mutations for creating exports
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
  
  console.log("\n=== REPORT-RELATED MUTATIONS ===\n");
  const mutations: any = await client.request(mutationsQuery);
  for (const f of mutations.__schema.mutationType.fields) {
    if (f.name.toLowerCase().includes('report') || f.name.toLowerCase().includes('export')) {
      console.log(`  ${f.name}`);
    }
  }
}

main().catch(console.error);

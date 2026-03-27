/**
 * Fetch price change history from Boulevard API
 */

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";

const BLVD_API_URL = "https://dashboard.boulevard.io/api/2020-01/admin";

function generateAuthHeader(): string {
  const apiKey = process.env.BLVD_API_KEY;
  const apiSecret = process.env.BLVD_API_SECRET;
  const businessId = process.env.BLVD_BUSINESS_ID;
  if (!apiKey || !apiSecret || !businessId) throw new Error("Missing creds");

  const prefix = "blvd-admin-v1";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, "base64");
  const signature = crypto.createHmac("sha256", rawKey).update(payload, "utf8").digest("base64");
  return `Basic ${Buffer.from(`${apiKey}:${signature}${payload}`, "utf8").toString("base64")}`;
}

const getClient = () => new GraphQLClient(BLVD_API_URL, { headers: { Authorization: generateAuthHeader() } });

// Try to introspect the schema for price-related types
const INTROSPECT_QUERY = gql`
  query IntrospectPriceTypes {
    __schema {
      types {
        name
        description
        fields {
          name
          description
        }
      }
    }
  }
`;

// Try service options which might have pricing
const SERVICE_OPTIONS_QUERY = gql`
  query GetServiceOptions($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          serviceOptions {
            id
            name
            priceDelta
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Try to get service pricing info
const SERVICE_PRICING_QUERY = gql`
  query GetServicePricing($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          price
          pricingDisplay
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Check for audit log or history
const AUDIT_LOG_QUERY = gql`
  query GetAuditLog($first: Int!) {
    auditLogs(first: $first) {
      edges {
        node {
          id
          action
          createdAt
          details
        }
      }
    }
  }
`;

// Check business settings
const BUSINESS_SETTINGS_QUERY = gql`
  query GetBusinessSettings {
    business {
      id
      name
      settings {
        pricingDisplayMode
      }
    }
  }
`;

async function main() {
  const client = getClient();

  console.log("Exploring Boulevard API for price history...\n");

  // Try service pricing
  console.log("1. Checking service pricing fields...");
  try {
    const data = await client.request<any>(SERVICE_PRICING_QUERY, { first: 5 });
    console.log("   Service pricing response:", JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.log("   Error:", e.message?.substring(0, 200));
  }

  // Try service options
  console.log("\n2. Checking service options (priceDelta)...");
  try {
    const data = await client.request<any>(SERVICE_OPTIONS_QUERY, { first: 5 });
    console.log("   Service options response:", JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.log("   Error:", e.message?.substring(0, 200));
  }

  // Try audit logs
  console.log("\n3. Checking audit logs...");
  try {
    const data = await client.request<any>(AUDIT_LOG_QUERY, { first: 5 });
    console.log("   Audit log response:", JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.log("   Error:", e.message?.substring(0, 200));
  }

  // Try business settings
  console.log("\n4. Checking business settings...");
  try {
    const data = await client.request<any>(BUSINESS_SETTINGS_QUERY);
    console.log("   Business settings response:", JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.log("   Error:", e.message?.substring(0, 200));
  }

  // Search schema for price-related fields
  console.log("\n5. Searching schema for price-related types...");
  try {
    const schema = await client.request<any>(INTROSPECT_QUERY);
    const priceTypes = schema.__schema.types.filter((t: any) =>
      t.name?.toLowerCase().includes('price') ||
      t.description?.toLowerCase().includes('price') ||
      t.fields?.some((f: any) => f.name?.toLowerCase().includes('price'))
    );
    console.log("   Price-related types found:", priceTypes.map((t: any) => t.name));

    for (const type of priceTypes.slice(0, 5)) {
      console.log(`\n   Type: ${type.name}`);
      if (type.fields) {
        const priceFields = type.fields.filter((f: any) =>
          f.name?.toLowerCase().includes('price') ||
          f.name?.toLowerCase().includes('cost') ||
          f.name?.toLowerCase().includes('amount')
        );
        priceFields.forEach((f: any) => console.log(`     - ${f.name}: ${f.description || 'no description'}`));
      }
    }
  } catch (e: any) {
    console.log("   Error:", e.message?.substring(0, 200));
  }
}

main();

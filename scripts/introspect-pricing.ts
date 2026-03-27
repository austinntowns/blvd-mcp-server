/**
 * Introspect Boulevard schema for pricing fields
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

// Get all fields for specific types
const TYPE_FIELDS_QUERY = gql`
  query GetTypeFields($typeName: String!) {
    __type(name: $typeName) {
      name
      kind
      fields {
        name
        description
        type {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
  }
`;

async function main() {
  const client = getClient();

  const typesToCheck = [
    'Service',
    'ServiceOverride',
    'ServiceOptionGroup',
    'ServiceOption',
    'MembershipPlan',
    'Membership',
    'Product',
    'OrderServiceLine',
    'AppointmentService',
    'StaffService',
  ];

  console.log("Introspecting Boulevard schema for pricing fields...\n");

  for (const typeName of typesToCheck) {
    try {
      const data = await client.request<any>(TYPE_FIELDS_QUERY, { typeName });
      const type = data.__type;

      if (!type) {
        console.log(`❌ ${typeName}: Not found`);
        continue;
      }

      console.log(`\n📦 ${type.name} (${type.kind})`);

      // Find price-related fields
      const allFields = type.fields || [];
      const priceFields = allFields.filter((f: any) =>
        f.name?.toLowerCase().includes('price') ||
        f.name?.toLowerCase().includes('cost') ||
        f.name?.toLowerCase().includes('amount') ||
        f.name?.toLowerCase().includes('total') ||
        f.name?.toLowerCase().includes('fee')
      );

      if (priceFields.length > 0) {
        console.log("   💰 Price-related fields:");
        priceFields.forEach((f: any) => {
          const typeName = f.type?.name || f.type?.ofType?.name || 'unknown';
          console.log(`      - ${f.name}: ${typeName} ${f.description ? `(${f.description.substring(0, 60)}...)` : ''}`);
        });
      }

      // Show all fields for reference
      console.log("   📋 All fields:");
      allFields.slice(0, 15).forEach((f: any) => {
        const typeName = f.type?.name || f.type?.ofType?.name || 'unknown';
        console.log(`      - ${f.name}: ${typeName}`);
      });
      if (allFields.length > 15) {
        console.log(`      ... and ${allFields.length - 15} more fields`);
      }

    } catch (e: any) {
      console.log(`❌ ${typeName}: Error - ${e.message?.substring(0, 80)}`);
    }
  }
}

main();

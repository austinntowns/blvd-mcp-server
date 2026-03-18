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
  // Check Appointment fields
  const aptQuery = gql`
    query {
      __type(name: "Appointment") {
        fields {
          name
          type { name kind ofType { name } }
        }
      }
    }
  `;
  
  const aptData = await client.request(aptQuery);
  console.log("=== APPOINTMENT FIELDS ===");
  const fields = (aptData as any).__type.fields;
  for (const f of fields) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }

  // Check AppointmentService fields
  const svcQuery = gql`
    query {
      __type(name: "AppointmentService") {
        fields {
          name
          type { name kind ofType { name } }
        }
      }
    }
  `;
  
  const svcData = await client.request(svcQuery);
  console.log("\n=== APPOINTMENT SERVICE FIELDS ===");
  const svcFields = (svcData as any).__type.fields;
  for (const f of svcFields) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }

  // Check Order fields (might have revenue)
  const orderQuery = gql`
    query {
      __type(name: "Order") {
        fields {
          name
          type { name kind ofType { name } }
        }
      }
    }
  `;
  
  const orderData = await client.request(orderQuery);
  console.log("\n=== ORDER FIELDS ===");
  const orderFields = (orderData as any).__type.fields;
  for (const f of orderFields) {
    const typeName = f.type.name || f.type.ofType?.name || f.type.kind;
    console.log(`  ${f.name}: ${typeName}`);
  }
}

main().catch(console.error);

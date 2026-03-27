/**
 * Fetch full service and product descriptions
 */

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import { writeFileSync, readFileSync } from "fs";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const errMsg = e.message || "";
      const status = e.response?.status;
      const isRetryable = errMsg.includes("API limit") || [429, 502, 503, 504].includes(status);
      if (isRetryable && attempt < maxRetries - 1) {
        const waitMatch = errMsg.match(/wait (\d+)ms/);
        const delay = waitMatch ? parseInt(waitMatch[1]) + 100 : 500 * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// Services with full descriptions
const SERVICES_FULL_QUERY = gql`
  query GetServices($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          defaultPrice
          defaultDuration
          active
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

// Products with full descriptions
const PRODUCTS_FULL_QUERY = gql`
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          unitPrice
          unitCost
          active
          barcode
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

async function fetchAllPages<T>(
  query: string,
  field: string,
  variables: Record<string, any> = {},
  maxPages = 100
): Promise<T[]> {
  const client = getClient();
  const allItems: T[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let page = 0;

  while (hasNextPage && page < maxPages) {
    if (page > 0) await sleep(400);
    const data = await withRetry(() =>
      client.request<any>(query, { first: 100, after: cursor, ...variables })
    );
    const connection = data[field];
    allItems.push(...connection.edges.map((e: any) => e.node));
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
    page++;
    if (page % 5 === 0) console.log(`    Page ${page}...`);
  }

  return allItems;
}

async function main() {
  console.log("Fetching full descriptions...\n");

  // Load existing data
  const existingData = JSON.parse(readFileSync("exports/hello-sugar-raw-data.json", "utf-8"));

  // 1. Services with descriptions
  console.log("1. Fetching services with full descriptions...");
  const services = await fetchAllPages<any>(SERVICES_FULL_QUERY, "services");
  console.log(`   Fetched ${services.length} services`);

  const withDesc = services.filter((s: any) => s.description && s.description.trim().length > 0);
  console.log(`   Services with descriptions: ${withDesc.length}`);

  existingData.servicesWithDescriptions = services;

  // 2. Products with descriptions
  console.log("\n2. Fetching products with full descriptions...");
  const products = await fetchAllPages<any>(PRODUCTS_FULL_QUERY, "products");
  console.log(`   Fetched ${products.length} products`);

  const productsWithDesc = products.filter((p: any) => p.description && p.description.trim().length > 0);
  console.log(`   Products with descriptions: ${productsWithDesc.length}`);

  existingData.productsWithDescriptions = products;

  // Save
  existingData.descriptionsAddedAt = new Date().toISOString();
  writeFileSync("exports/hello-sugar-raw-data.json", JSON.stringify(existingData, null, 2));
  console.log("\n✅ Saved to exports/hello-sugar-raw-data.json");

  // Sample output
  console.log("\n📋 SAMPLE SERVICE DESCRIPTIONS:");
  withDesc.slice(0, 5).forEach((s: any) => {
    console.log(`\n${s.name}:`);
    console.log(`  ${s.description?.substring(0, 150)}...`);
  });

  console.log("\n📋 SAMPLE PRODUCT DESCRIPTIONS:");
  productsWithDesc.slice(0, 5).forEach((p: any) => {
    console.log(`\n${p.name}:`);
    console.log(`  ${p.description?.substring(0, 150)}...`);
  });
}

main();

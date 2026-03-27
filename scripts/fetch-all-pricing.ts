/**
 * Fetch all current pricing from Boulevard
 */

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import { writeFileSync, readFileSync, existsSync } from "fs";

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

// Services with default prices (no serviceOverrides - requires locationId)
const SERVICES_QUERY = gql`
  query GetServices($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          defaultPrice
          defaultDuration
          active
          category { name }
          serviceOptionGroups {
            name
            serviceOptions {
              name
              defaultPriceDelta
            }
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

// Membership plans with pricing
const MEMBERSHIP_PLANS_QUERY = gql`
  query GetMembershipPlans($first: Int!, $after: String) {
    membershipPlans(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          unitPrice
          interval
          active
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Products with pricing
const PRODUCTS_QUERY = gql`
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          name
          unitPrice
          unitCost
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
    if (page % 10 === 0) console.log(`    Page ${page}...`);
  }

  return allItems;
}

function centsToDollars(cents: number | null | undefined): string {
  if (cents == null) return "N/A";
  return `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  console.log("Fetching Hello Sugar Pricing Data...\n");

  const pricingData: any = {
    fetchedAt: new Date().toISOString(),
    services: [],
    membershipPlans: [],
    products: [],
  };

  // 1. Services
  console.log("1. Fetching services with pricing...");
  try {
    const services = await fetchAllPages<any>(SERVICES_QUERY, "services");
    pricingData.services = services;

    const withPrice = services.filter((s: any) => s.defaultPrice != null);
    const activeWithPrice = withPrice.filter((s: any) => s.active !== false);

    console.log(`   Total services: ${services.length}`);
    console.log(`   With default price: ${withPrice.length}`);
    console.log(`   Active with price: ${activeWithPrice.length}`);

    // Price distribution
    const prices = activeWithPrice.map((s: any) => s.defaultPrice).filter(Boolean);
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const avg = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
      console.log(`   Price range: ${centsToDollars(min)} - ${centsToDollars(max)}`);
      console.log(`   Average price: ${centsToDollars(avg)}`);
    }

    // Top 10 by price
    console.log("\n   Top 10 services by price:");
    activeWithPrice
      .sort((a: any, b: any) => (b.defaultPrice || 0) - (a.defaultPrice || 0))
      .slice(0, 10)
      .forEach((s: any) => {
        console.log(`     - ${s.name}: ${centsToDollars(s.defaultPrice)} (${s.defaultDuration}min)`);
      });

    // By category
    const byCategory: Record<string, any[]> = {};
    for (const s of activeWithPrice) {
      const cat = s.category?.name || "Uncategorized";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(s);
    }

    console.log("\n   Average price by category:");
    Object.entries(byCategory)
      .map(([cat, services]) => ({
        cat,
        avg: services.reduce((sum: number, s: any) => sum + (s.defaultPrice || 0), 0) / services.length,
        count: services.length
      }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 10)
      .forEach(({ cat, avg, count }) => {
        console.log(`     - ${cat}: ${centsToDollars(avg)} (${count} services)`);
      });

  } catch (e: any) {
    console.log(`   Error: ${e.message?.substring(0, 150)}`);
  }

  // 2. Membership Plans
  console.log("\n2. Fetching membership plans...");
  try {
    const plans = await fetchAllPages<any>(MEMBERSHIP_PLANS_QUERY, "membershipPlans");
    pricingData.membershipPlans = plans;

    const withPrice = plans.filter((p: any) => p.unitPrice != null);
    const activePlans = withPrice.filter((p: any) => p.active !== false);

    console.log(`   Total plans: ${plans.length}`);
    console.log(`   With price: ${withPrice.length}`);
    console.log(`   Active: ${activePlans.length}`);

    // Price distribution
    const prices = activePlans.map((p: any) => p.unitPrice).filter(Boolean);
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const avg = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
      console.log(`   Price range: ${centsToDollars(min)} - ${centsToDollars(max)}`);
      console.log(`   Average price: ${centsToDollars(avg)}`);
    }

    // Sample plans
    console.log("\n   Sample membership plans:");
    activePlans.slice(0, 15).forEach((p: any) => {
      console.log(`     - ${p.name}: ${centsToDollars(p.unitPrice)}/${p.interval}`);
    });

  } catch (e: any) {
    console.log(`   Error: ${e.message?.substring(0, 150)}`);
  }

  // 3. Products
  console.log("\n3. Fetching products...");
  try {
    const products = await fetchAllPages<any>(PRODUCTS_QUERY, "products");
    pricingData.products = products;

    const withPrice = products.filter((p: any) => p.unitPrice != null);
    const activeProducts = withPrice.filter((p: any) => p.active !== false);

    console.log(`   Total products: ${products.length}`);
    console.log(`   With price: ${withPrice.length}`);
    console.log(`   Active: ${activeProducts.length}`);

    // Price distribution
    const prices = activeProducts.map((p: any) => p.unitPrice).filter(Boolean);
    if (prices.length > 0) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const avg = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
      console.log(`   Price range: ${centsToDollars(min)} - ${centsToDollars(max)}`);
      console.log(`   Average price: ${centsToDollars(avg)}`);
    }

    // By category
    console.log("\n   Products by category:");
    const byCategory: Record<string, any[]> = {};
    for (const p of activeProducts) {
      const cat = p.category?.name || "Uncategorized";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(p);
    }
    Object.entries(byCategory)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .forEach(([cat, products]) => {
        const avgPrice = products.reduce((sum: number, p: any) => sum + (p.unitPrice || 0), 0) / products.length;
        console.log(`     - ${cat}: ${products.length} products, avg ${centsToDollars(avgPrice)}`);
      });

  } catch (e: any) {
    console.log(`   Error: ${e.message?.substring(0, 150)}`);
  }

  // Save pricing data
  writeFileSync("exports/hello-sugar-pricing.json", JSON.stringify(pricingData, null, 2));
  console.log("\n✅ Saved to exports/hello-sugar-pricing.json");

  // Note about history
  console.log("\n" + "=".repeat(60));
  console.log("⚠️  PRICE HISTORY NOT AVAILABLE");
  console.log("=".repeat(60));
  console.log("Boulevard API only exposes current pricing, not change history.");
  console.log("\nTo track price changes over time, you would need to:");
  console.log("  1. Run this script on a schedule (daily/weekly) and store snapshots");
  console.log("  2. Set up Boulevard webhooks for 'service.updated' events");
  console.log("  3. Check Boulevard's admin dashboard for any audit log feature");
  console.log("\nThis snapshot can serve as a baseline for future comparisons.");
}

main();

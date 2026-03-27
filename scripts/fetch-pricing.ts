/**
 * Fetch current pricing from Boulevard API
 */

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import { writeFileSync } from "fs";

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
        console.log(`  Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// Service with pricing via serviceOptionGroups
const SERVICES_WITH_OPTIONS_QUERY = gql`
  query GetServicesWithOptions($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          category { name }
          serviceOptionGroups {
            id
            name
            options {
              id
              name
              priceDelta
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

// Service overrides (location-specific pricing)
const SERVICE_OVERRIDES_QUERY = gql`
  query GetServiceOverrides($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          serviceOverrides {
            location { id name }
            price
            duration
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
          price
          interval
          intervalCount
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
const PRODUCTS_WITH_PRICING_QUERY = gql`
  query GetProductsWithPricing($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          barcode
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Staff services (staff-specific pricing)
const STAFF_SERVICES_QUERY = gql`
  query GetStaffServices($staffId: ID!, $first: Int!, $after: String) {
    staffServices(staffId: $staffId, first: $first, after: $after) {
      edges {
        node {
          id
          price
          duration
          service { id name }
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
  maxPages = 20
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
  console.log("Fetching Hello Sugar Pricing Data...\n");

  const pricingData: any = {
    fetchedAt: new Date().toISOString(),
    membershipPlans: [],
    serviceOverrides: [],
    serviceOptions: [],
  };

  // 1. Membership Plans
  console.log("1. Fetching membership plans...");
  try {
    const plans = await fetchAllPages<any>(MEMBERSHIP_PLANS_QUERY, "membershipPlans", {}, 50);
    pricingData.membershipPlans = plans;
    console.log(`   Found ${plans.length} membership plans`);

    // Show sample with prices
    const plansWithPrices = plans.filter((p: any) => p.price);
    console.log(`   Plans with prices: ${plansWithPrices.length}`);
    plansWithPrices.slice(0, 5).forEach((p: any) => {
      console.log(`     - ${p.name}: $${p.price} (${p.interval})`);
    });
  } catch (e: any) {
    console.log(`   Error: ${e.message?.substring(0, 100)}`);
  }

  // 2. Service Overrides (location-specific pricing)
  console.log("\n2. Fetching service overrides (location pricing)...");
  try {
    const services = await fetchAllPages<any>(SERVICE_OVERRIDES_QUERY, "services", {}, 30);
    const overrides: any[] = [];

    for (const svc of services) {
      if (svc.serviceOverrides?.length > 0) {
        for (const override of svc.serviceOverrides) {
          if (override.price) {
            overrides.push({
              serviceId: svc.id,
              serviceName: svc.name,
              locationId: override.location?.id,
              locationName: override.location?.name,
              price: override.price,
              duration: override.duration,
            });
          }
        }
      }
    }

    pricingData.serviceOverrides = overrides;
    console.log(`   Found ${overrides.length} service price overrides`);

    // Group by service for summary
    const byService: Record<string, any[]> = {};
    for (const o of overrides) {
      if (!byService[o.serviceName]) byService[o.serviceName] = [];
      byService[o.serviceName].push(o);
    }

    console.log(`   Services with location-specific pricing: ${Object.keys(byService).length}`);
    Object.entries(byService).slice(0, 5).forEach(([name, prices]) => {
      const priceRange = prices.map((p: any) => parseFloat(p.price)).filter(Boolean);
      if (priceRange.length > 0) {
        const min = Math.min(...priceRange);
        const max = Math.max(...priceRange);
        console.log(`     - ${name}: $${min} - $${max} (${prices.length} locations)`);
      }
    });
  } catch (e: any) {
    console.log(`   Error: ${e.message?.substring(0, 100)}`);
  }

  // 3. Service Options (add-on pricing)
  console.log("\n3. Fetching service options (add-on pricing)...");
  try {
    const services = await fetchAllPages<any>(SERVICES_WITH_OPTIONS_QUERY, "services", {}, 30);
    const options: any[] = [];

    for (const svc of services) {
      if (svc.serviceOptionGroups?.length > 0) {
        for (const group of svc.serviceOptionGroups) {
          for (const opt of group.options || []) {
            if (opt.priceDelta) {
              options.push({
                serviceId: svc.id,
                serviceName: svc.name,
                groupName: group.name,
                optionName: opt.name,
                priceDelta: opt.priceDelta,
              });
            }
          }
        }
      }
    }

    pricingData.serviceOptions = options;
    console.log(`   Found ${options.length} service option price deltas`);
    options.slice(0, 5).forEach((o: any) => {
      console.log(`     - ${o.serviceName} > ${o.optionName}: +$${o.priceDelta}`);
    });
  } catch (e: any) {
    console.log(`   Error: ${e.message?.substring(0, 100)}`);
  }

  // Save pricing data
  writeFileSync("exports/hello-sugar-pricing.json", JSON.stringify(pricingData, null, 2));
  console.log("\n✅ Saved pricing data to exports/hello-sugar-pricing.json");

  // Summary
  console.log("\n📊 PRICING SUMMARY");
  console.log("=".repeat(50));
  console.log(`Membership Plans: ${pricingData.membershipPlans.length}`);
  console.log(`Service Price Overrides: ${pricingData.serviceOverrides.length}`);
  console.log(`Service Option Deltas: ${pricingData.serviceOptions.length}`);

  // Note about history
  console.log("\n⚠️  NOTE: Boulevard API does not expose price change history.");
  console.log("   This is current pricing only. To track history, you'd need to:");
  console.log("   1. Run this script periodically and store snapshots");
  console.log("   2. Use Boulevard webhooks to capture price change events");
  console.log("   3. Check if Boulevard has an audit log in their dashboard UI");
}

main();

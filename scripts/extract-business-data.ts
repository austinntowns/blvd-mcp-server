/**
 * Hello Sugar Business Data Extraction Script
 * Extracts comprehensive business data from Boulevard API for training/analysis
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

  if (!apiKey || !apiSecret || !businessId) {
    throw new Error("Missing Boulevard credentials");
  }

  const prefix = "blvd-admin-v1";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, "base64");
  const signature = crypto
    .createHmac("sha256", rawKey)
    .update(payload, "utf8")
    .digest("base64");

  const token = `${signature}${payload}`;
  const httpBasicPayload = `${apiKey}:${token}`;
  return `Basic ${Buffer.from(httpBasicPayload, "utf8").toString("base64")}`;
}

function getClient(): GraphQLClient {
  return new GraphQLClient(BLVD_API_URL, {
    headers: { Authorization: generateAuthHeader() },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelay = 500
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const errMsg = e.message || "";
      const status = e.response?.status;
      const isRetryable =
        errMsg.includes("API limit") ||
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 504;

      if (isRetryable && attempt < maxRetries - 1) {
        const waitMatch = errMsg.match(/wait (\d+)ms/);
        const delay = waitMatch
          ? parseInt(waitMatch[1]) + 100
          : baseDelay * Math.pow(2, attempt);
        console.log(`  Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ===== QUERIES =====

const LOCATIONS_QUERY = gql`
  query GetLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after) {
      edges {
        node {
          id
          name
          address {
            line1
            line2
            city
            state
            zip
          }
          phone
          businessName
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const SERVICES_QUERY = gql`
  query GetServices($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          category {
            id
            name
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

const SERVICE_CATEGORIES_QUERY = gql`
  query GetServiceCategories($first: Int!, $after: String) {
    serviceCategories(first: $first, after: $after) {
      edges {
        node {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const STAFF_QUERY = gql`
  query GetStaff($first: Int!, $after: String) {
    staff(first: $first, after: $after) {
      edges {
        node {
          id
          name
          displayName
          firstName
          lastName
          email
          mobilePhone
          role {
            id
            name
          }
          locations {
            id
            name
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

const CLIENTS_QUERY = gql`
  query GetClients($first: Int!, $after: String) {
    clients(first: $first, after: $after) {
      edges {
        node {
          id
          name
          firstName
          lastName
          email
          mobilePhone
          createdAt
          appointmentCount
          tags {
            id
            name
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

const MEMBERSHIPS_QUERY = gql`
  query GetMemberships($first: Int!, $after: String) {
    memberships(first: $first, after: $after) {
      edges {
        node {
          id
          name
          interval
          unitPrice
          startOn
          cancelOn
          vouchers {
            services {
              id
              name
            }
            quantity
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

const PRODUCTS_QUERY = gql`
  query GetProducts($first: Int!, $after: String) {
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

const APPOINTMENTS_QUERY = gql`
  query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
    appointments(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id
          startAt
          endAt
          duration
          cancelled
          state
          createdAt
          client {
            id
            name
          }
          appointmentServices {
            service {
              id
              name
            }
            staff {
              id
              name
            }
            duration
            price
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

// ===== PAGINATED FETCH =====

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
    if (page > 0) await sleep(400); // Rate limiting

    const data = await withRetry(() =>
      client.request<any>(query, { first: 100, after: cursor, ...variables })
    );

    const connection = data[field];
    allItems.push(...connection.edges.map((e: any) => e.node));
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
    page++;
    console.log(`  Page ${page}: ${connection.edges.length} items`);
  }

  return allItems;
}

// ===== MAIN EXTRACTION =====

interface BusinessData {
  extractedAt: string;
  locations: any[];
  services: any[];
  serviceCategories: any[];
  staff: any[];
  clients: { total: number; sample: any[] };
  memberships: any[];
  products: any[];
  appointmentStats: any;
}

async function extractBusinessData(): Promise<BusinessData> {
  console.log("Starting Hello Sugar Business Data Extraction...\n");

  // 1. Locations
  console.log("📍 Fetching locations...");
  const locations = await fetchAllPages<any>(
    LOCATIONS_QUERY,
    "locations"
  );
  console.log(`   Found ${locations.length} locations\n`);

  // 2. Services
  console.log("💇 Fetching services...");
  const services = await fetchAllPages<any>(SERVICES_QUERY, "services");
  console.log(`   Found ${services.length} services\n`);

  // 3. Service Categories
  console.log("📂 Fetching service categories...");
  const serviceCategories = await fetchAllPages<any>(
    SERVICE_CATEGORIES_QUERY,
    "serviceCategories"
  );
  console.log(`   Found ${serviceCategories.length} categories\n`);

  // 4. Staff
  console.log("👥 Fetching staff...");
  const staff = await fetchAllPages<any>(STAFF_QUERY, "staff");
  console.log(`   Found ${staff.length} staff members\n`);

  // 5. Clients (sample - can be huge)
  console.log("👤 Fetching clients (sampling)...");
  const clientsSample = await fetchAllPages<any>(
    CLIENTS_QUERY,
    "clients",
    {},
    50 // Limit pages
  );
  console.log(`   Sampled ${clientsSample.length} clients\n`);

  // 6. Memberships
  console.log("🎫 Fetching memberships...");
  const memberships = await fetchAllPages<any>(
    MEMBERSHIPS_QUERY,
    "memberships"
  );
  console.log(`   Found ${memberships.length} memberships\n`);

  // 7. Products
  console.log("🛍️ Fetching products...");
  const products = await fetchAllPages<any>(PRODUCTS_QUERY, "products");
  console.log(`   Found ${products.length} products\n`);

  // 8. Appointment stats (sample from a few locations)
  console.log("📅 Sampling appointments for stats...");
  const appointmentStats: Record<string, any> = {};
  const sampleLocations = locations.slice(0, 5);

  for (const loc of sampleLocations) {
    console.log(`   Sampling ${loc.name}...`);
    await sleep(500);
    const apts = await fetchAllPages<any>(
      APPOINTMENTS_QUERY,
      "appointments",
      { locationId: loc.id },
      10 // Limited pages per location
    );
    appointmentStats[loc.name] = {
      sampleSize: apts.length,
      services: countServices(apts),
    };
  }

  return {
    extractedAt: new Date().toISOString(),
    locations,
    services,
    serviceCategories,
    staff,
    clients: { total: clientsSample.length, sample: clientsSample.slice(0, 100) },
    memberships,
    products,
    appointmentStats,
  };
}

function countServices(appointments: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const apt of appointments) {
    for (const svc of apt.appointmentServices || []) {
      const name = svc.service?.name || "Unknown";
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  return counts;
}

// ===== RUN =====

async function main() {
  try {
    const data = await extractBusinessData();

    // Save raw data
    writeFileSync(
      "exports/hello-sugar-raw-data.json",
      JSON.stringify(data, null, 2)
    );
    console.log("\n✅ Raw data saved to exports/hello-sugar-raw-data.json");

    // Generate summary
    generateSummary(data);
  } catch (e) {
    console.error("❌ Extraction failed:", e);
    process.exit(1);
  }
}

function generateSummary(data: BusinessData) {
  const activeServices = data.services.filter((s) => !s.disabled);
  const activeStaff = data.staff;
  const locationCount = data.locations.length;

  // Service price stats
  const prices = activeServices
    .map((s) => parseFloat(s.defaultPrice) || 0)
    .filter((p) => p > 0);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // Service duration stats
  const durations = activeServices
    .map((s) => s.defaultDuration || 0)
    .filter((d) => d > 0);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

  // Staff by role
  const staffByRole: Record<string, number> = {};
  for (const s of activeStaff) {
    const role = s.role?.name || "No Role";
    staffByRole[role] = (staffByRole[role] || 0) + 1;
  }

  // Services by category
  const servicesByCategory: Record<string, any[]> = {};
  for (const s of activeServices) {
    const cat = s.category?.name || "Uncategorized";
    if (!servicesByCategory[cat]) servicesByCategory[cat] = [];
    servicesByCategory[cat].push(s);
  }

  // States where Hello Sugar operates
  const states = new Set(data.locations.map((l) => l.address?.state).filter(Boolean));

  console.log("\n📊 SUMMARY");
  console.log("=".repeat(50));
  console.log(`Locations: ${locationCount}`);
  console.log(`States: ${[...states].join(", ")}`);
  console.log(`Active Services: ${activeServices.length}`);
  console.log(`Service Categories: ${Object.keys(servicesByCategory).length}`);
  console.log(`Staff Members: ${activeStaff.length}`);
  console.log(`Memberships: ${data.memberships.length}`);
  console.log(`Products: ${data.products.length}`);
  console.log(`\nPrice Range: $${minPrice} - $${maxPrice} (avg: $${avgPrice.toFixed(2)})`);
  console.log(`Avg Service Duration: ${avgDuration.toFixed(0)} minutes`);
}

main();

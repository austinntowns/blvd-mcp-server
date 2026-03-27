/**
 * Enhanced data extraction - Second iteration
 * Gets appointment statistics, service popularity, and better client data
 */

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

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

// Clients with appointment count > 0
const CLIENTS_WITH_HISTORY_QUERY = gql`
  query GetClients($first: Int!, $after: String) {
    clients(first: $first, after: $after) {
      edges {
        node {
          id
          appointmentCount
          createdAt
          tags { name }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Appointments with service details
const APPOINTMENTS_DETAILED_QUERY = gql`
  query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
    appointments(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id
          startAt
          cancelled
          state
          appointmentServices {
            service { id name }
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

// Gift cards if available
const GIFT_CARDS_QUERY = gql`
  query GetGiftCardDesigns($first: Int!, $after: String) {
    giftCardDesigns(first: $first, after: $after) {
      edges {
        node {
          id
          name
          preset
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Business info
const BUSINESS_QUERY = gql`
  query GetBusiness {
    business {
      id
      name
      website
      timezone
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

async function main() {
  console.log("Enhanced Hello Sugar Data Extraction (Iteration 2)\n");

  // Load existing data
  const existingData = JSON.parse(readFileSync("exports/hello-sugar-raw-data.json", "utf-8"));

  // 1. Business Info
  console.log("🏢 Fetching business info...");
  try {
    const client = getClient();
    const bizData = await withRetry(() => client.request<any>(BUSINESS_QUERY));
    console.log(`   Business: ${bizData.business.name}`);
    existingData.business = bizData.business;
  } catch (e: any) {
    console.log(`   Error: ${e.message}`);
  }

  // 2. Client stats (sample more clients, track appointment counts)
  console.log("\n👤 Sampling more client data...");
  const clientsSample = await fetchAllPages<any>(CLIENTS_WITH_HISTORY_QUERY, "clients", {}, 100);

  // Calculate real appointment distribution
  const appointmentCounts = clientsSample.map(c => c.appointmentCount || 0);
  const distribution = {
    "0 visits": 0,
    "1 visit": 0,
    "2-5 visits": 0,
    "6-10 visits": 0,
    "11-20 visits": 0,
    "21-50 visits": 0,
    "51+ visits": 0,
  };

  for (const count of appointmentCounts) {
    if (count === 0) distribution["0 visits"]++;
    else if (count === 1) distribution["1 visit"]++;
    else if (count <= 5) distribution["2-5 visits"]++;
    else if (count <= 10) distribution["6-10 visits"]++;
    else if (count <= 20) distribution["11-20 visits"]++;
    else if (count <= 50) distribution["21-50 visits"]++;
    else distribution["51+ visits"]++;
  }

  const totalAppts = appointmentCounts.reduce((a, b) => a + b, 0);
  const avgAppts = totalAppts / clientsSample.length;
  const maxAppts = Math.max(...appointmentCounts);

  // Tag analysis
  const tagCounts: Record<string, number> = {};
  for (const c of clientsSample) {
    for (const tag of c.tags || []) {
      tagCounts[tag.name] = (tagCounts[tag.name] || 0) + 1;
    }
  }

  existingData.clientStats = {
    sampleSize: clientsSample.length,
    totalAppointments: totalAppts,
    avgAppointmentsPerClient: avgAppts,
    maxAppointments: maxAppts,
    distribution,
    topTags: Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30),
    clientsWithMultipleVisits: appointmentCounts.filter(c => c > 1).length,
    retentionRate: ((appointmentCounts.filter(c => c > 1).length / clientsSample.length) * 100).toFixed(1),
  };

  console.log(`   Sampled ${clientsSample.length} clients`);
  console.log(`   Total appointments in sample: ${totalAppts.toLocaleString()}`);
  console.log(`   Avg appointments/client: ${avgAppts.toFixed(2)}`);
  console.log(`   Max appointments: ${maxAppts}`);
  console.log(`   Repeat clients (2+ visits): ${existingData.clientStats.retentionRate}%`);

  // 3. Sample appointments from multiple locations for service popularity
  console.log("\n📅 Sampling appointments for service popularity...");
  const locations = existingData.locations.slice(0, 20); // Sample 20 locations
  const serviceCounts: Record<string, number> = {};
  let totalAptsScanned = 0;

  for (const loc of locations) {
    try {
      console.log(`   ${loc.name.substring(0, 40)}...`);
      const apts = await fetchAllPages<any>(
        APPOINTMENTS_DETAILED_QUERY,
        "appointments",
        { locationId: loc.id },
        20 // 20 pages per location
      );

      for (const apt of apts) {
        if (apt.cancelled) continue;
        for (const svc of apt.appointmentServices || []) {
          const name = svc.service?.name || "Unknown";
          serviceCounts[name] = (serviceCounts[name] || 0) + 1;
          totalAptsScanned++;
        }
      }
    } catch (e: any) {
      console.log(`   Error: ${e.message}`);
    }
    await sleep(500);
  }

  const topServices = Object.entries(serviceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);

  existingData.servicePopularity = {
    totalAppointmentsScanned: totalAptsScanned,
    locationsScanned: locations.length,
    topServices,
  };

  console.log(`   Scanned ${totalAptsScanned.toLocaleString()} appointment services`);
  console.log(`   Top 5 services:`);
  topServices.slice(0, 5).forEach(([name, count], i) => {
    console.log(`     ${i + 1}. ${name}: ${count}`);
  });

  // 4. Gift cards
  console.log("\n🎁 Checking gift card designs...");
  try {
    const giftCards = await fetchAllPages<any>(GIFT_CARDS_QUERY, "giftCardDesigns", {}, 5);
    existingData.giftCards = giftCards;
    console.log(`   Found ${giftCards.length} gift card designs`);
  } catch (e: any) {
    console.log(`   Gift cards not available: ${e.message.substring(0, 50)}`);
    existingData.giftCards = [];
  }

  // Save enhanced data
  existingData.enhancedAt = new Date().toISOString();
  writeFileSync("exports/hello-sugar-raw-data.json", JSON.stringify(existingData, null, 2));
  console.log("\n✅ Enhanced data saved");

  // Generate updated summary
  console.log("\n📊 ENHANCED SUMMARY");
  console.log("=".repeat(50));
  console.log(`Client Sample Size: ${existingData.clientStats.sampleSize.toLocaleString()}`);
  console.log(`Avg Appointments/Client: ${existingData.clientStats.avgAppointmentsPerClient.toFixed(2)}`);
  console.log(`Repeat Client Rate: ${existingData.clientStats.retentionRate}%`);
  console.log(`\nTop Services (by booking frequency):`);
  topServices.slice(0, 10).forEach(([name, count], i) => {
    const pct = ((count / totalAptsScanned) * 100).toFixed(1);
    console.log(`  ${i + 1}. ${name}: ${count} (${pct}%)`);
  });
}

main();

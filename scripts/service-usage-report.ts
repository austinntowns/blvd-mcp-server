import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import { getLocations } from "../lib/boulevard";

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

function getClient(): GraphQLClient {
  return new GraphQLClient(BLVD_API_URL, {
    headers: { Authorization: generateAuthHeader() },
  });
}

const APPOINTMENTS_QUERY = gql`
  query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
    appointments(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id
          startAt
          cancelled
          state
          appointmentServices {
            service {
              id
              name
              category { name }
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

interface ServiceCount {
  id: string;
  name: string;
  category: string;
  count: number;
}

async function main() {
  const args = process.argv.slice(2);
  let stateFilter = "UT";
  let months = 12;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state" && args[i + 1]) {
      stateFilter = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === "--all-states") {
      stateFilter = "";
    } else if (args[i] === "--months" && args[i + 1]) {
      months = parseInt(args[i + 1]);
      i++;
    }
  }

  // Calculate date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startDateStr = startDate.toISOString().split("T")[0];

  console.log("=".repeat(70));
  console.log("SERVICE USAGE REPORT");
  console.log("=".repeat(70));
  console.log(`Period: Last ${months} months (since ${startDateStr})`);
  console.log(`State Filter: ${stateFilter || "All"}\n`);

  // Get locations
  const allLocations = await getLocations();
  const locations = stateFilter
    ? allLocations.filter(loc => loc.address?.state?.toUpperCase() === stateFilter)
    : allLocations;

  console.log(`Processing ${locations.length} locations...\n`);

  const serviceMap = new Map<string, ServiceCount>();
  let totalAppointments = 0;
  let totalServices = 0;

  const client = getClient();

  for (const location of locations) {
    process.stdout.write(`  ${location.name}...`);
    let locationCount = 0;

    let hasNext = true;
    let cursor: string | null = null;
    let pageCount = 0;

    while (hasNext) {
      if (pageCount > 0) await new Promise(r => setTimeout(r, 350));

      let data: any;
      let retries = 0;
      while (retries < 5) {
        try {
          data = await client.request(APPOINTMENTS_QUERY, {
            locationId: location.id,
            first: 100,
            after: cursor,
          });
          break;
        } catch (e: any) {
          const status = e.response?.status;
          const errMsg = e.message || "";
          if (([429, 502, 503, 504].includes(status) || errMsg.includes("API limit")) && retries < 4) {
            retries++;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
            continue;
          }
          throw e;
        }
      }

      for (const edge of data.appointments.edges) {
        const apt = edge.node;

        // Skip cancelled or non-final appointments
        if (apt.cancelled || apt.state !== "FINAL") continue;

        // Filter by date range
        const aptDate = apt.startAt?.split("T")[0];
        if (!aptDate || aptDate < startDateStr) continue;

        totalAppointments++;
        locationCount++;

        // Count each service
        for (const svc of apt.appointmentServices || []) {
          if (!svc.service?.name) continue;

          totalServices++;
          const serviceId = svc.service.id;
          const existing = serviceMap.get(serviceId);

          if (existing) {
            existing.count++;
          } else {
            serviceMap.set(serviceId, {
              id: serviceId,
              name: svc.service.name,
              category: svc.service.category?.name || "Uncategorized",
              count: 1,
            });
          }
        }
      }

      hasNext = data.appointments.pageInfo.hasNextPage;
      cursor = data.appointments.pageInfo.endCursor;
      pageCount++;

      // Stop if we've gone past our date range (appointments ordered by date)
      // Actually appointments may not be ordered, so we need to scan all
    }

    console.log(` ${locationCount.toLocaleString()} appointments`);
    await new Promise(r => setTimeout(r, 300));
  }

  // Sort by count descending
  const sortedServices = [...serviceMap.values()].sort((a, b) => b.count - a.count);

  // Results
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log(`\nTotal appointments: ${totalAppointments.toLocaleString()}`);
  console.log(`Total services performed: ${totalServices.toLocaleString()}`);
  console.log(`Unique services: ${sortedServices.length}`);

  // Top 50 services
  console.log("\n--- TOP 50 SERVICES ---");
  console.log("Count".padStart(8) + "  " + "Service".padEnd(50) + "Category");
  console.log("-".repeat(90));

  for (const svc of sortedServices.slice(0, 50)) {
    const count = svc.count.toLocaleString().padStart(8);
    const name = svc.name.slice(0, 48).padEnd(50);
    console.log(`${count}  ${name}${svc.category}`);
  }

  // Services with 0 uses (not in our data)
  const usedServiceIds = new Set(sortedServices.map(s => s.id));

  // Bottom services (rarely used)
  console.log("\n--- RARELY USED SERVICES (1-5 times) ---");
  const rareServices = sortedServices.filter(s => s.count >= 1 && s.count <= 5);
  console.log(`${rareServices.length} services used 1-5 times in ${months} months\n`);

  for (const svc of rareServices.slice(0, 30)) {
    console.log(`  ${svc.count}x  ${svc.name}`);
  }
  if (rareServices.length > 30) {
    console.log(`  ... and ${rareServices.length - 30} more`);
  }

  // Summary by category
  console.log("\n--- USAGE BY CATEGORY ---");
  const categoryTotals = new Map<string, number>();
  for (const svc of sortedServices) {
    const current = categoryTotals.get(svc.category) || 0;
    categoryTotals.set(svc.category, current + svc.count);
  }

  const sortedCategories = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
  console.log("Count".padStart(8) + "  Category");
  console.log("-".repeat(50));
  for (const [cat, count] of sortedCategories.slice(0, 25)) {
    console.log(`${count.toLocaleString().padStart(8)}  ${cat}`);
  }

  // Export to JSON
  const outputPath = "service-usage.json";
  const fs = await import("fs");
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    period: { months, startDate: startDateStr },
    stateFilter: stateFilter || "all",
    totalAppointments,
    totalServices,
    services: sortedServices,
  }, null, 2));
  console.log(`\nFull data exported to ${outputPath}`);
}

main().catch(console.error);

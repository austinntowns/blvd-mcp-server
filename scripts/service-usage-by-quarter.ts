import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import { getLocations } from "../lib/boulevard";
import * as fs from "fs";

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

interface QuarterlyCount {
  "2025-Q1": number;
  "2025-Q2": number;
  "2025-Q3": number;
  "2025-Q4": number;
  "2026-Q1": number;
  total: number;
}

interface ServiceData {
  id: string;
  name: string;
  category: string;
  quarters: QuarterlyCount;
}

function getQuarter(dateStr: string): string | null {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12

  if (year !== 2025 && year !== 2026) return null;

  let quarter: number;
  if (month <= 3) quarter = 1;
  else if (month <= 6) quarter = 2;
  else if (month <= 9) quarter = 3;
  else quarter = 4;

  return `${year}-Q${quarter}`;
}

async function main() {
  // Date range: 2025-01-01 to now (captures all of 2025 and 2026 so far)
  const startDateStr = "2025-01-01";
  const endDate = new Date();

  console.log("=".repeat(80));
  console.log("SERVICE USAGE BY QUARTER - DEPRECATION ANALYSIS");
  console.log("=".repeat(80));
  console.log(`Period: ${startDateStr} to ${endDate.toISOString().split("T")[0]}`);
  console.log(`Analyzing all locations...\n`);

  const allLocations = await getLocations();
  console.log(`Processing ${allLocations.length} locations...\n`);

  const serviceMap = new Map<string, ServiceData>();
  let totalAppointments = 0;
  let locationsProcessed = 0;
  let locationErrors: string[] = [];

  const client = getClient();

  for (const location of allLocations) {
    process.stdout.write(`  ${location.name}...`);
    let locationCount = 0;

    let hasNext = true;
    let cursor: string | null = null;
    let pageCount = 0;

    try {
      while (hasNext) {
        if (pageCount > 0) await new Promise(r => setTimeout(r, 500)); // Increased delay

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
            if (([406, 429, 502, 503, 504].includes(status) || errMsg.includes("API limit") || errMsg.includes("unknown error")) && retries < 4) {
              retries++;
              console.log(` (retry ${retries})...`);
              await new Promise(r => setTimeout(r, 2000 * Math.pow(2, retries)));
              continue;
            }
            throw e;
          }
        }

        if (!data) {
          throw new Error("Failed after retries");
        }

        for (const edge of data.appointments.edges) {
        const apt = edge.node;

        // Skip cancelled or non-final appointments
        if (apt.cancelled || apt.state !== "FINAL") continue;

        // Get date and quarter
        const aptDate = apt.startAt?.split("T")[0];
        if (!aptDate || aptDate < startDateStr) continue;

        const quarter = getQuarter(aptDate);
        if (!quarter) continue; // Skip if not in 2025-2026

        totalAppointments++;
        locationCount++;

        // Count each service
        for (const svc of apt.appointmentServices || []) {
          if (!svc.service?.name) continue;

          const serviceId = svc.service.id;
          let existing = serviceMap.get(serviceId);

          if (!existing) {
            existing = {
              id: serviceId,
              name: svc.service.name,
              category: svc.service.category?.name || "Uncategorized",
              quarters: {
                "2025-Q1": 0,
                "2025-Q2": 0,
                "2025-Q3": 0,
                "2025-Q4": 0,
                "2026-Q1": 0,
                total: 0,
              },
            };
            serviceMap.set(serviceId, existing);
          }

          if (quarter in existing.quarters) {
            (existing.quarters as any)[quarter]++;
          }
          existing.quarters.total++;
        }
      }

        hasNext = data.appointments.pageInfo.hasNextPage;
        cursor = data.appointments.pageInfo.endCursor;
        pageCount++;
      }

      console.log(` ${locationCount.toLocaleString()} appointments`);
      locationsProcessed++;
    } catch (e: any) {
      console.log(` ERROR: ${e.message?.slice(0, 50) || "unknown"}`);
      locationErrors.push(location.name);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Sort by total count ascending (lowest first for deprecation candidates)
  const sortedServices = [...serviceMap.values()].sort((a, b) => a.quarters.total - b.quarters.total);

  // Results
  console.log("\n" + "=".repeat(80));
  console.log("RESULTS");
  console.log("=".repeat(80));
  console.log(`\nLocations processed: ${locationsProcessed}/${allLocations.length}`);
  if (locationErrors.length > 0) {
    console.log(`Locations with errors: ${locationErrors.length} (${locationErrors.slice(0, 5).join(", ")}${locationErrors.length > 5 ? "..." : ""})`);
  }
  console.log(`Total appointments analyzed: ${totalAppointments.toLocaleString()}`);
  console.log(`Unique services: ${sortedServices.length}`);

  // CSV-style output for easy analysis
  console.log("\n" + "=".repeat(80));
  console.log("DEPRECATION CANDIDATES (sorted by total usage, lowest first)");
  console.log("=".repeat(80));

  const header = "Service Name".padEnd(55) + "| 2025-Q1 | 2025-Q2 | 2025-Q3 | 2025-Q4 | 2026-Q1 | TOTAL";
  console.log(header);
  console.log("-".repeat(header.length));

  for (const svc of sortedServices) {
    const name = svc.name.slice(0, 53).padEnd(55);
    const q1_25 = svc.quarters["2025-Q1"].toString().padStart(7);
    const q2_25 = svc.quarters["2025-Q2"].toString().padStart(7);
    const q3_25 = svc.quarters["2025-Q3"].toString().padStart(7);
    const q4_25 = svc.quarters["2025-Q4"].toString().padStart(7);
    const q1_26 = svc.quarters["2026-Q1"].toString().padStart(7);
    const total = svc.quarters.total.toString().padStart(5);
    console.log(`${name}|${q1_25} |${q2_25} |${q3_25} |${q4_25} |${q1_26} |${total}`);
  }

  // Highlight strong deprecation candidates
  console.log("\n" + "=".repeat(80));
  console.log("STRONG DEPRECATION CANDIDATES");
  console.log("Services with 0 uses in 2025-Q4 and 2026-Q1 (no recent activity)");
  console.log("=".repeat(80));

  const noRecentActivity = sortedServices.filter(
    s => s.quarters["2025-Q4"] === 0 && s.quarters["2026-Q1"] === 0 && s.quarters.total > 0
  );
  console.log(`\n${noRecentActivity.length} services with no activity in Q4 2025 or Q1 2026:\n`);

  for (const svc of noRecentActivity) {
    console.log(`  ${svc.quarters.total}x total | ${svc.name} (${svc.category})`);
  }

  // Services NEVER used
  const neverUsed = sortedServices.filter(s => s.quarters.total === 0);
  if (neverUsed.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log(`SERVICES WITH 0 USES IN 2025-2026: ${neverUsed.length}`);
    console.log("=".repeat(80));
    for (const svc of neverUsed.slice(0, 50)) {
      console.log(`  ${svc.name} (${svc.category})`);
    }
    if (neverUsed.length > 50) {
      console.log(`  ... and ${neverUsed.length - 50} more`);
    }
  }

  // By category summary
  console.log("\n" + "=".repeat(80));
  console.log("USAGE BY CATEGORY");
  console.log("=".repeat(80));

  const categoryTotals = new Map<string, QuarterlyCount>();
  for (const svc of sortedServices) {
    let catData = categoryTotals.get(svc.category);
    if (!catData) {
      catData = { "2025-Q1": 0, "2025-Q2": 0, "2025-Q3": 0, "2025-Q4": 0, "2026-Q1": 0, total: 0 };
      categoryTotals.set(svc.category, catData);
    }
    catData["2025-Q1"] += svc.quarters["2025-Q1"];
    catData["2025-Q2"] += svc.quarters["2025-Q2"];
    catData["2025-Q3"] += svc.quarters["2025-Q3"];
    catData["2025-Q4"] += svc.quarters["2025-Q4"];
    catData["2026-Q1"] += svc.quarters["2026-Q1"];
    catData.total += svc.quarters.total;
  }

  const sortedCats = [...categoryTotals.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log("\n" + "Category".padEnd(35) + "| 2025-Q1 | 2025-Q2 | 2025-Q3 | 2025-Q4 | 2026-Q1 | TOTAL");
  console.log("-".repeat(100));
  for (const [cat, data] of sortedCats) {
    const name = cat.slice(0, 33).padEnd(35);
    console.log(`${name}|${data["2025-Q1"].toString().padStart(7)} |${data["2025-Q2"].toString().padStart(7)} |${data["2025-Q3"].toString().padStart(7)} |${data["2025-Q4"].toString().padStart(7)} |${data["2026-Q1"].toString().padStart(7)} |${data.total.toString().padStart(5)}`);
  }

  // Export to JSON
  const outputPath = "exports/service-usage-by-quarter.json";
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    period: { start: startDateStr, end: endDate.toISOString().split("T")[0] },
    locationsProcessed,
    totalLocations: allLocations.length,
    locationErrors,
    totalAppointments,
    services: sortedServices,
    categories: Object.fromEntries(sortedCats),
  }, null, 2));
  console.log(`\nFull data exported to ${outputPath}`);

  // Also export a simple CSV for easy viewing
  const csvPath = "exports/service-usage-by-quarter.csv";
  const csvLines = [
    "Service Name,Category,2025-Q1,2025-Q2,2025-Q3,2025-Q4,2026-Q1,Total",
    ...sortedServices.map(s =>
      `"${s.name.replace(/"/g, '""')}","${s.category}",${s.quarters["2025-Q1"]},${s.quarters["2025-Q2"]},${s.quarters["2025-Q3"]},${s.quarters["2025-Q4"]},${s.quarters["2026-Q1"]},${s.quarters.total}`
    )
  ];
  fs.writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`CSV exported to ${csvPath}`);
}

main().catch(console.error);

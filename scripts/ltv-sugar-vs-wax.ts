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

// Classify service as sugar, wax, or other
function classifyService(serviceName: string, categoryName?: string): "sugar" | "wax" | "other" {
  const name = serviceName.toLowerCase();
  const cat = (categoryName || "").toLowerCase();

  // Check for sugar first (more specific)
  if (name.includes("sugar") || cat.includes("sugar")) {
    return "sugar";
  }

  // Check for wax
  if (name.includes("wax") || cat.includes("wax")) {
    return "wax";
  }

  return "other";
}

interface ClientData {
  id: string;
  name: string;
  firstServiceType: "sugar" | "wax" | "other";
  firstServiceDate: string;
  totalRevenue: number;
  appointmentCount: number;
}

// Query appointments with service prices and client info
const APPOINTMENTS_WITH_PRICE_QUERY = gql`
  query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
    appointments(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id
          startAt
          cancelled
          state
          client {
            id
            name
          }
          appointmentServices {
            price
            service {
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

async function getAppointmentsForLocation(locationId: string, limit: number = 3000): Promise<any[]> {
  const client = getClient();
  const appointments: any[] = [];
  let hasNext = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNext && appointments.length < limit) {
    if (pageCount > 0) {
      await new Promise(r => setTimeout(r, 400));
    }

    let retries = 0;
    let data: any;

    while (retries < 5) {
      try {
        data = await client.request(APPOINTMENTS_WITH_PRICE_QUERY, {
          locationId,
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

    if (!data) throw new Error("Failed after retries");

    for (const edge of data.appointments.edges) {
      const apt = edge.node;
      // Only count completed appointments (not cancelled)
      if (!apt.cancelled && apt.client && apt.state === "FINAL") {
        appointments.push(apt);
      }
    }

    hasNext = data.appointments.pageInfo.hasNextPage;
    cursor = data.appointments.pageInfo.endCursor;
    pageCount++;
  }

  return appointments;
}

async function main() {
  const args = process.argv.slice(2);
  let stateFilter = "UT";
  let maxPerLocation = 5000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state" && args[i + 1]) {
      stateFilter = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === "--all-states") {
      stateFilter = "";
    } else if (args[i] === "--limit" && args[i + 1]) {
      maxPerLocation = parseInt(args[i + 1]);
      i++;
    }
  }

  console.log("=".repeat(60));
  console.log("LIFETIME VALUE: SUGAR vs WAX CLIENTS");
  console.log("=".repeat(60));
  console.log(`State Filter: ${stateFilter || "All"}`);
  console.log("");

  // Get locations
  console.log("Fetching locations...");
  const allLocations = await getLocations();
  const locations = stateFilter
    ? allLocations.filter(loc => loc.address?.state?.toUpperCase() === stateFilter)
    : allLocations;

  console.log(`Found ${locations.length} locations\n`);

  // Aggregate client data across locations
  const clientMap = new Map<string, ClientData>();
  let totalAppointments = 0;

  for (const location of locations) {
    console.log(`Processing ${location.name}...`);

    try {
      const appointments = await getAppointmentsForLocation(location.id, maxPerLocation);
      console.log(`  Found ${appointments.length} completed appointments`);
      totalAppointments += appointments.length;

      for (const apt of appointments) {
        if (!apt.client?.id) continue;

        const clientId = apt.client.id;
        const aptDate = apt.startAt;

        // Calculate revenue from all services in this appointment
        let revenue = 0;
        const serviceTypes: ("sugar" | "wax" | "other")[] = [];

        for (const svc of apt.appointmentServices || []) {
          // Price might be in cents or a Money object
          const price = svc.price;
          if (typeof price === "number") {
            revenue += price / 100;
          } else if (price?.amount) {
            revenue += price.amount / 100;
          }

          if (svc.service?.name) {
            serviceTypes.push(classifyService(svc.service.name, svc.service.category?.name));
          }
        }

        // Get primary service type (prefer sugar/wax over other)
        const primaryType = serviceTypes.find(t => t !== "other") || "other";

        // Update client data
        let client = clientMap.get(clientId);
        if (!client) {
          client = {
            id: clientId,
            name: apt.client.name || "Unknown",
            firstServiceType: primaryType,
            firstServiceDate: aptDate,
            totalRevenue: 0,
            appointmentCount: 0,
          };
          clientMap.set(clientId, client);
        } else {
          // Check if this appointment is earlier (their first visit)
          if (aptDate < client.firstServiceDate) {
            client.firstServiceDate = aptDate;
            if (primaryType !== "other") {
              client.firstServiceType = primaryType;
            }
          }
        }

        client.totalRevenue += revenue;
        client.appointmentCount++;
      }
    } catch (err: any) {
      console.error(`  Error: ${err.message.slice(0, 100)}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Analyze by cohort
  const sugarClients = [...clientMap.values()].filter(c => c.firstServiceType === "sugar");
  const waxClients = [...clientMap.values()].filter(c => c.firstServiceType === "wax");
  const otherClients = [...clientMap.values()].filter(c => c.firstServiceType === "other");

  const calcStats = (clients: ClientData[]) => {
    if (clients.length === 0) return { count: 0, avgLtv: 0, avgVisits: 0, medianLtv: 0, totalRevenue: 0 };

    const revenues = clients.map(c => c.totalRevenue).sort((a, b) => a - b);
    const totalRevenue = revenues.reduce((a, b) => a + b, 0);
    const totalVisits = clients.reduce((a, c) => a + c.appointmentCount, 0);

    return {
      count: clients.length,
      avgLtv: totalRevenue / clients.length,
      avgVisits: totalVisits / clients.length,
      medianLtv: revenues[Math.floor(revenues.length / 2)],
      totalRevenue,
    };
  };

  const sugarStats = calcStats(sugarClients);
  const waxStats = calcStats(waxClients);
  const otherStats = calcStats(otherClients);

  // Results
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  console.log(`\nTotal appointments analyzed: ${totalAppointments.toLocaleString()}`);
  console.log(`Total unique clients: ${clientMap.size.toLocaleString()}`);

  console.log("\n--- SUGAR-FIRST CLIENTS ---");
  console.log(`  Count: ${sugarStats.count.toLocaleString()}`);
  console.log(`  Avg LTV: $${sugarStats.avgLtv.toFixed(2)}`);
  console.log(`  Median LTV: $${sugarStats.medianLtv.toFixed(2)}`);
  console.log(`  Avg Visits: ${sugarStats.avgVisits.toFixed(1)}`);
  console.log(`  Total Revenue: $${sugarStats.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}`);

  console.log("\n--- WAX-FIRST CLIENTS ---");
  console.log(`  Count: ${waxStats.count.toLocaleString()}`);
  console.log(`  Avg LTV: $${waxStats.avgLtv.toFixed(2)}`);
  console.log(`  Median LTV: $${waxStats.medianLtv.toFixed(2)}`);
  console.log(`  Avg Visits: ${waxStats.avgVisits.toFixed(1)}`);
  console.log(`  Total Revenue: $${waxStats.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}`);

  console.log("\n--- OTHER (non-sugar/wax first) ---");
  console.log(`  Count: ${otherStats.count.toLocaleString()}`);
  console.log(`  Avg LTV: $${otherStats.avgLtv.toFixed(2)}`);
  console.log(`  Total Revenue: $${otherStats.totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}`);

  // Comparison
  console.log("\n" + "=".repeat(60));
  console.log("COMPARISON: SUGAR vs WAX");
  console.log("=".repeat(60));

  if (sugarStats.avgLtv > 0 && waxStats.avgLtv > 0) {
    const diff = sugarStats.avgLtv - waxStats.avgLtv;
    const pctDiff = (diff / waxStats.avgLtv) * 100;
    const winner = diff > 0 ? "SUGAR" : "WAX";

    console.log(`\n${winner} clients have HIGHER LTV`);
    console.log(`  Difference: $${Math.abs(diff).toFixed(2)} (${Math.abs(pctDiff).toFixed(1)}%)`);
    console.log(`\nVisit frequency:`);
    console.log(`  Sugar: ${sugarStats.avgVisits.toFixed(1)} visits/client`);
    console.log(`  Wax: ${waxStats.avgVisits.toFixed(1)} visits/client`);
  }

  // Top clients by LTV
  console.log("\n--- TOP 10 CLIENTS BY LTV ---");
  const topClients = [...clientMap.values()]
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10);

  for (const c of topClients) {
    const revenue = `$${c.totalRevenue.toFixed(0)}`.padStart(7);
    const visits = `${c.appointmentCount} visits`.padStart(10);
    const type = c.firstServiceType.toUpperCase().padEnd(5);
    console.log(`  ${revenue} | ${visits} | ${type} first | ${c.name}`);
  }
}

main().catch(console.error);

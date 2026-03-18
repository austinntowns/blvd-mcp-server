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

// Classify membership as sugar, wax, or other
function classifyMembership(membershipName: string): "sugar" | "wax" | "other" {
  const name = membershipName.toLowerCase();
  if (name.includes("sugar")) return "sugar";
  if (name.includes("wax")) return "wax";
  return "other";
}

// Classify service as sugar or wax
function classifyService(serviceName: string): "sugar" | "wax" | "other" {
  const name = serviceName.toLowerCase();
  if (name.includes("sugar")) return "sugar";
  if (name.includes("wax")) return "wax";
  return "other";
}

interface ClientData {
  id: string;
  name: string;
  membershipType: "sugar" | "wax" | "other";
  membershipName: string;
  membershipStatus: string;
  totalRevenue: number;
  sugarRevenue: number;
  waxRevenue: number;
  otherRevenue: number;
  appointmentCount: number;
  firstVisit?: string;
  lastVisit?: string;
}

const MEMBERSHIPS_QUERY = gql`
  query GetMemberships($first: Int!, $after: String) {
    memberships(first: $first, after: $after) {
      edges {
        node {
          id
          name
          status
          startOn
          client {
            id
            name
          }
          location {
            id
            address { state }
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

const APPOINTMENTS_QUERY = gql`
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
          }
          appointmentServices {
            price
            service {
              name
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

async function getAllMemberships(stateFilter?: string): Promise<Map<string, ClientData>> {
  const client = getClient();
  const clientMap = new Map<string, ClientData>();
  let hasNext = true;
  let cursor: string | null = null;
  let pageCount = 0;

  console.log("Fetching memberships...");

  while (hasNext) {
    if (pageCount > 0) await new Promise(r => setTimeout(r, 350));

    let data: any;
    let retries = 0;
    while (retries < 5) {
      try {
        data = await client.request(MEMBERSHIPS_QUERY, { first: 100, after: cursor });
        break;
      } catch (e: any) {
        if (retries < 4) {
          retries++;
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
          continue;
        }
        throw e;
      }
    }

    for (const edge of data.memberships.edges) {
      const m = edge.node;
      if (!m.client?.id) continue;

      // Filter by state if specified
      if (stateFilter && m.location?.address?.state?.toUpperCase() !== stateFilter) continue;

      const clientId = m.client.id;
      const membershipType = classifyMembership(m.name);

      // Only track sugar or wax members
      if (membershipType === "other") continue;

      // If client already exists, prefer active membership or first one
      const existing = clientMap.get(clientId);
      if (existing) {
        // Prefer active over inactive
        if (m.status === "ACTIVE" && existing.membershipStatus !== "ACTIVE") {
          existing.membershipType = membershipType;
          existing.membershipName = m.name;
          existing.membershipStatus = m.status;
        }
        continue;
      }

      clientMap.set(clientId, {
        id: clientId,
        name: m.client.name || "Unknown",
        membershipType,
        membershipName: m.name,
        membershipStatus: m.status,
        totalRevenue: 0,
        sugarRevenue: 0,
        waxRevenue: 0,
        otherRevenue: 0,
        appointmentCount: 0,
      });
    }

    hasNext = data.memberships.pageInfo.hasNextPage;
    cursor = data.memberships.pageInfo.endCursor;
    pageCount++;
  }

  console.log(`Found ${clientMap.size} clients with sugar/wax memberships\n`);
  return clientMap;
}

async function getAppointmentsForLocation(locationId: string, limit: number = 5000): Promise<any[]> {
  const client = getClient();
  const appointments: any[] = [];
  let hasNext = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNext && appointments.length < limit) {
    if (pageCount > 0) await new Promise(r => setTimeout(r, 350));

    let data: any;
    let retries = 0;
    while (retries < 5) {
      try {
        data = await client.request(APPOINTMENTS_QUERY, { locationId, first: 100, after: cursor });
        break;
      } catch (e: any) {
        if (retries < 4) {
          retries++;
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
          continue;
        }
        throw e;
      }
    }

    for (const edge of data.appointments.edges) {
      const apt = edge.node;
      if (!apt.cancelled && apt.state === "FINAL" && apt.client?.id) {
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
  let maxPerLocation = 10000;

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

  console.log("=".repeat(70));
  console.log("LIFETIME VALUE BY MEMBERSHIP TYPE: SUGAR vs WAX");
  console.log("=".repeat(70));
  console.log(`State Filter: ${stateFilter || "All"}\n`);

  // Get all memberships and build client map
  const clientMap = await getAllMemberships(stateFilter);

  if (clientMap.size === 0) {
    console.log("No sugar/wax memberships found.");
    return;
  }

  // Get locations
  const allLocations = await getLocations();
  const locations = stateFilter
    ? allLocations.filter(loc => loc.address?.state?.toUpperCase() === stateFilter)
    : allLocations;

  console.log(`Processing appointments from ${locations.length} locations...\n`);

  // Process appointments for each location
  for (const location of locations) {
    console.log(`  ${location.name}...`);

    try {
      const appointments = await getAppointmentsForLocation(location.id, maxPerLocation);

      for (const apt of appointments) {
        const clientId = apt.client.id;
        const clientData = clientMap.get(clientId);
        if (!clientData) continue; // Not a member we're tracking

        // Track visit dates
        if (!clientData.firstVisit || apt.startAt < clientData.firstVisit) {
          clientData.firstVisit = apt.startAt;
        }
        if (!clientData.lastVisit || apt.startAt > clientData.lastVisit) {
          clientData.lastVisit = apt.startAt;
        }

        clientData.appointmentCount++;

        // Calculate revenue by service type
        for (const svc of apt.appointmentServices || []) {
          let price = 0;
          if (typeof svc.price === "number") {
            price = svc.price / 100;
          } else if (svc.price?.amount) {
            price = svc.price.amount / 100;
          }

          const serviceType = classifyService(svc.service?.name || "");
          clientData.totalRevenue += price;

          if (serviceType === "sugar") {
            clientData.sugarRevenue += price;
          } else if (serviceType === "wax") {
            clientData.waxRevenue += price;
          } else {
            clientData.otherRevenue += price;
          }
        }
      }
    } catch (err: any) {
      console.error(`    Error: ${err.message.slice(0, 80)}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // Analyze by membership type
  const sugarMembers = [...clientMap.values()].filter(c => c.membershipType === "sugar" && c.appointmentCount > 0);
  const waxMembers = [...clientMap.values()].filter(c => c.membershipType === "wax" && c.appointmentCount > 0);

  const calcStats = (clients: ClientData[]) => {
    if (clients.length === 0) return null;

    const revenues = clients.map(c => c.totalRevenue).sort((a, b) => a - b);
    const sugarRevs = clients.map(c => c.sugarRevenue);
    const waxRevs = clients.map(c => c.waxRevenue);

    return {
      count: clients.length,
      avgLtv: revenues.reduce((a, b) => a + b, 0) / clients.length,
      medianLtv: revenues[Math.floor(revenues.length / 2)],
      avgVisits: clients.reduce((a, c) => a + c.appointmentCount, 0) / clients.length,
      totalRevenue: revenues.reduce((a, b) => a + b, 0),
      avgSugarRev: sugarRevs.reduce((a, b) => a + b, 0) / clients.length,
      avgWaxRev: waxRevs.reduce((a, b) => a + b, 0) / clients.length,
      activeCount: clients.filter(c => c.membershipStatus === "ACTIVE").length,
    };
  };

  const sugarStats = calcStats(sugarMembers);
  const waxStats = calcStats(waxMembers);

  // Results
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));

  console.log("\n--- SUGAR MEMBERSHIP HOLDERS ---");
  if (sugarStats) {
    console.log(`  Total Members: ${sugarStats.count.toLocaleString()} (${sugarStats.activeCount} active)`);
    console.log(`  Avg LTV: $${sugarStats.avgLtv.toFixed(2)}`);
    console.log(`  Median LTV: $${sugarStats.medianLtv.toFixed(2)}`);
    console.log(`  Avg Visits: ${sugarStats.avgVisits.toFixed(1)}`);
    console.log(`  Total Revenue: $${sugarStats.totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`  Avg Sugar Service Rev: $${sugarStats.avgSugarRev.toFixed(2)}`);
    console.log(`  Avg Wax Service Rev: $${sugarStats.avgWaxRev.toFixed(2)}`);
  } else {
    console.log("  No data");
  }

  console.log("\n--- WAX MEMBERSHIP HOLDERS ---");
  if (waxStats) {
    console.log(`  Total Members: ${waxStats.count.toLocaleString()} (${waxStats.activeCount} active)`);
    console.log(`  Avg LTV: $${waxStats.avgLtv.toFixed(2)}`);
    console.log(`  Median LTV: $${waxStats.medianLtv.toFixed(2)}`);
    console.log(`  Avg Visits: ${waxStats.avgVisits.toFixed(1)}`);
    console.log(`  Total Revenue: $${waxStats.totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`  Avg Sugar Service Rev: $${waxStats.avgSugarRev.toFixed(2)}`);
    console.log(`  Avg Wax Service Rev: $${waxStats.avgWaxRev.toFixed(2)}`);
  } else {
    console.log("  No data");
  }

  // Comparison
  if (sugarStats && waxStats) {
    console.log("\n" + "=".repeat(70));
    console.log("COMPARISON");
    console.log("=".repeat(70));

    const ltvDiff = sugarStats.avgLtv - waxStats.avgLtv;
    const ltvPct = (ltvDiff / waxStats.avgLtv) * 100;
    const visitDiff = sugarStats.avgVisits - waxStats.avgVisits;
    const winner = ltvDiff > 0 ? "SUGAR" : "WAX";

    console.log(`\n${winner} members have HIGHER LTV`);
    console.log(`  LTV Difference: $${Math.abs(ltvDiff).toFixed(2)} (${Math.abs(ltvPct).toFixed(1)}%)`);
    console.log(`  Visit Difference: ${Math.abs(visitDiff).toFixed(1)} visits`);

    console.log(`\nSugar members: $${sugarStats.avgLtv.toFixed(0)} LTV, ${sugarStats.avgVisits.toFixed(1)} visits`);
    console.log(`Wax members: $${waxStats.avgLtv.toFixed(0)} LTV, ${waxStats.avgVisits.toFixed(1)} visits`);
  }

  // Top members by LTV
  console.log("\n--- TOP 10 MEMBERS BY LTV ---");
  const topMembers = [...clientMap.values()]
    .filter(c => c.appointmentCount > 0)
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10);

  for (const c of topMembers) {
    const rev = `$${c.totalRevenue.toFixed(0)}`.padStart(7);
    const visits = `${c.appointmentCount}`.padStart(3);
    const type = c.membershipType.toUpperCase().padEnd(5);
    const status = c.membershipStatus === "ACTIVE" ? "" : " (inactive)";
    console.log(`  ${rev} | ${visits} visits | ${type} | ${c.name}${status}`);
  }
}

main().catch(console.error);

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const httpBasicPayload = `${apiKey}:${token}`;
  return `Basic ${Buffer.from(httpBasicPayload, "utf8").toString("base64")}`;
}

const client = new GraphQLClient(BLVD_API_URL, {
  headers: { Authorization: generateAuthHeader() }
});

const toUrn = (id: string) => id.startsWith("urn:") ? id : `urn:blvd:Staff:${id}`;
const toUuid = (id: string) => id.replace(/^urn:blvd:Staff:/, "");

// Load location config
const configPath = path.join(__dirname, "../config/utah-locations.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

interface LocationData {
  id: string;
  shortName: string;
  utilization: number;
  appointmentsNext2Wk: number;
  staffCount: number;
  highUtilShifts: { staff: string; day: string; bucket: string; util: number }[];
  lowUtilShifts: { staff: string; day: string; bucket: string; util: number }[];
  capacityAlerts: string[];
}

const AM_START = 8, AM_END = 14, PM_START = 14, PM_END = 20;
const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Global staff map - loaded once
let globalStaffMap: Map<string, string> | null = null;

async function loadStaffMap(): Promise<Map<string, string>> {
  if (globalStaffMap) return globalStaffMap;

  const staffQuery = gql`
    query GetStaff($first: Int!, $after: String) {
      staff(first: $first, after: $after) {
        edges { node { id name displayName } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  globalStaffMap = new Map<string, string>();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const result = await client.request<any>(staffQuery, { first: 100, after: cursor });
    for (const edge of result.staff.edges) {
      const uuid = toUuid(edge.node.id);
      globalStaffMap.set(uuid, edge.node.displayName || edge.node.name);
    }
    hasMore = result.staff.pageInfo.hasNextPage;
    cursor = result.staff.pageInfo.endCursor;
  }

  return globalStaffMap;
}

async function analyzeLocation(location: any): Promise<LocationData> {
  const shiftsQuery = gql`
    query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
      shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
        shifts { staffId day clockIn clockOut available recurrenceStart recurrenceEnd }
      }
    }
  `;

  const apptsQuery = gql`
    query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
      appointments(locationId: $locationId, first: $first, after: $after) {
        edges {
          node {
            id startAt endAt duration cancelled state
            appointmentServices { staff { id name } duration }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  // 2 weeks forward for forecast
  const twoWeeksOut = new Date(today);
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  const twoWeeksOutStr = twoWeeksOut.toISOString().split("T")[0];

  // Fetch shifts
  const shiftsData = await client.request<any>(shiftsQuery, {
    locationId: location.id,
    startIso8601: todayStr,
    endIso8601: twoWeeksOutStr
  });

  // Get global staff map
  const staffMap = await loadStaffMap();

  // Fetch all appointments (paginate)
  const allAppts: any[] = [];
  let apptCursor: string | null = null;
  let hasMoreAppts = true;
  while (hasMoreAppts) {
    const apptsResult = await client.request<any>(apptsQuery, { locationId: location.id, first: 100, after: apptCursor });
    allAppts.push(...apptsResult.appointments.edges.map((e: any) => e.node));
    hasMoreAppts = apptsResult.appointments.pageInfo.hasNextPage;
    apptCursor = apptsResult.appointments.pageInfo.endCursor;
  }

  const periodStart = new Date(todayStr + "T00:00:00-06:00");
  const periodEnd = new Date(twoWeeksOutStr + "T23:59:59-06:00");

  const periodAppts = allAppts.filter((a: any) => {
    const d = new Date(a.startAt);
    return d >= periodStart && d <= periodEnd && !a.cancelled;
  });

  // Calculate utilization
  const bucketData = new Map<string, { staffName: string; day: number; bucket: string; availMin: number; bookedMin: number }>();

  for (const shift of shiftsData.shifts.shifts) {
    if (!shift.staffId || !shift.available) continue;
    const staffName = staffMap.get(shift.staffId) || "Unknown";
    if (staffName.toLowerCase().includes("training")) continue;

    const recStart = shift.recurrenceStart ? new Date(shift.recurrenceStart + "T00:00:00-06:00") : periodStart;
    const recEnd = shift.recurrenceEnd ? new Date(shift.recurrenceEnd + "T23:59:59-06:00") : periodEnd;

    let d = new Date(periodStart);
    while (d <= periodEnd) {
      if (d.getDay() === shift.day && d >= recStart && d <= recEnd) {
        const [h1, m1] = shift.clockIn.split(":").map(Number);
        const [h2, m2] = shift.clockOut.split(":").map(Number);
        const shiftStartHour = h1 + m1/60;
        const shiftEndHour = h2 + m2/60;
        const staffUrn = toUrn(shift.staffId);

        for (const bucket of ["AM", "PM"] as const) {
          const bStart = bucket === "AM" ? AM_START : PM_START;
          const bEnd = bucket === "AM" ? AM_END : PM_END;

          if (shiftStartHour < bEnd && shiftEndHour > bStart) {
            const bucketStart = new Date(d);
            bucketStart.setHours(Math.max(bStart, h1), h1 >= bStart ? m1 : 0, 0, 0);
            const bucketEnd = new Date(d);
            bucketEnd.setHours(Math.min(bEnd, h2), h2 <= bEnd ? m2 : 0, 0, 0);

            const availMin = (bucketEnd.getTime() - bucketStart.getTime()) / 60000;
            if (availMin <= 0) continue;

            const bucketAppts = periodAppts.filter((a: any) => {
              const aStart = new Date(a.startAt);
              const aEnd = new Date(a.endAt);
              const overlaps = aStart < bucketEnd && aEnd > bucketStart;
              const matchesStaff = a.appointmentServices?.some((svc: any) => svc.staff?.id === staffUrn);
              return overlaps && matchesStaff;
            });

            let bookedMin = 0;
            for (const apt of bucketAppts) {
              const aStart = Math.max(new Date(apt.startAt).getTime(), bucketStart.getTime());
              const aEnd = Math.min(new Date(apt.endAt).getTime(), bucketEnd.getTime());
              bookedMin += (aEnd - aStart) / 60000;
            }

            const key = `${shift.staffId}|${shift.day}|${bucket}`;
            if (!bucketData.has(key)) {
              bucketData.set(key, { staffName, day: shift.day, bucket, availMin: 0, bookedMin: 0 });
            }
            bucketData.get(key)!.availMin += availMin;
            bucketData.get(key)!.bookedMin += bookedMin;
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Calculate results
  let totalAvail = 0, totalBooked = 0;
  const shiftUtils: { staff: string; day: string; bucket: string; util: number }[] = [];

  for (const [_, data] of bucketData) {
    const util = data.availMin > 0 ? (data.bookedMin / data.availMin) * 100 : 0;
    totalAvail += data.availMin;
    totalBooked += data.bookedMin;
    shiftUtils.push({
      staff: data.staffName,
      day: dayNames[data.day],
      bucket: data.bucket === "AM" ? "8AM-2PM" : "2PM-8PM",
      util: Math.round(util)
    });
  }

  const overallUtil = totalAvail > 0 ? Math.round((totalBooked / totalAvail) * 100) : 0;

  const highUtilShifts = shiftUtils.filter(s => s.util >= 50).sort((a, b) => b.util - a.util).slice(0, 5);
  const lowUtilShifts = shiftUtils.filter(s => s.util < 20).sort((a, b) => a.util - b.util).slice(0, 5);

  const capacityAlerts: string[] = [];
  for (const shift of shiftUtils.filter(s => s.util >= 75)) {
    capacityAlerts.push(`${shift.staff} is ${shift.util}% booked ${shift.day} ${shift.bucket}`);
  }

  const uniqueStaff = new Set(shiftsData.shifts.shifts.filter((s: any) => s.staffId && s.available).map((s: any) => s.staffId));

  return {
    id: location.id,
    shortName: location.shortName,
    utilization: overallUtil,
    appointmentsNext2Wk: periodAppts.length,
    staffCount: uniqueStaff.size,
    highUtilShifts,
    lowUtilShifts,
    capacityAlerts
  };
}

async function generateBrief() {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Denver"
  });

  console.log("\n" + "═".repeat(65));
  console.log("🧠 HELLO SUGAR UTAH — DAILY AI BRIEF");
  console.log(`📅 ${dateStr}`);
  console.log("═".repeat(65));

  console.log("\nLoading staff directory...");
  await loadStaffMap();
  console.log(`✓ Loaded ${globalStaffMap?.size || 0} staff members`);

  console.log("\nAnalyzing your 7 locations...\n");

  const locationData: LocationData[] = [];

  for (const loc of config.owned) {
    process.stdout.write(`  📍 ${loc.shortName}...`);
    try {
      const data = await analyzeLocation(loc);
      locationData.push(data);
      console.log(` ✓ (${data.utilization}% util, ${data.appointmentsNext2Wk} appts)`);
    } catch (e: any) {
      console.log(` ✗ error`);
    }
  }

  if (locationData.length === 0) {
    console.log("\n⚠️  Could not analyze any locations. Check API credentials.");
    return;
  }

  locationData.sort((a, b) => b.utilization - a.utilization);

  // URGENT SECTION
  console.log("\n" + "═".repeat(65));
  console.log("🔴 URGENT — CAPACITY ALERTS");
  console.log("─".repeat(65));

  let urgentCount = 0;
  for (const loc of locationData) {
    for (const alert of loc.capacityAlerts) {
      urgentCount++;
      console.log(`\n${urgentCount}. [${loc.shortName}] ${alert}`);
      console.log(`   → Add coverage or open waitlist?`);
    }
  }
  if (urgentCount === 0) console.log("\n   ✓ No urgent capacity issues.");

  // OPPORTUNITIES
  console.log("\n" + "═".repeat(65));
  console.log("🟡 GROWTH OPPORTUNITIES (shifts ≥50% booked)");
  console.log("─".repeat(65));

  let oppCount = 0;
  for (const loc of locationData) {
    for (const shift of loc.highUtilShifts) {
      oppCount++;
      console.log(`\n${oppCount}. [${loc.shortName}] ${shift.staff} — ${shift.day} ${shift.bucket}: ${shift.util}%`);
    }
  }
  if (oppCount === 0) console.log("\n   No high-utilization shifts yet.");

  // UNDERUTILIZED
  console.log("\n" + "─".repeat(65));
  console.log("💤 UNDERUTILIZED (consider cutting or running promos)");

  for (const loc of locationData) {
    const low = loc.lowUtilShifts.filter(s => s.util < 15);
    if (low.length > 0) {
      console.log(`\n   [${loc.shortName}]`);
      for (const s of low.slice(0, 3)) {
        console.log(`   • ${s.staff} ${s.day} ${s.bucket}: only ${s.util}%`);
      }
    }
  }

  // LEADERBOARD
  console.log("\n" + "═".repeat(65));
  console.log("📊 LOCATION LEADERBOARD (next 2 weeks forecast)");
  console.log("─".repeat(65) + "\n");

  for (let i = 0; i < locationData.length; i++) {
    const loc = locationData[i];
    const bar = "█".repeat(Math.round(loc.utilization / 5)) + "░".repeat(20 - Math.round(loc.utilization / 5));
    const emoji = loc.utilization >= 40 ? "🟢" : loc.utilization >= 25 ? "🟡" : "🔴";

    console.log(`${i + 1}. ${emoji} ${loc.shortName.padEnd(14)} ${bar} ${String(loc.utilization).padStart(2)}%`);
    console.log(`      ${loc.staffCount} staff | ${loc.appointmentsNext2Wk} appts booked\n`);
  }

  // SUMMARY
  const avgUtil = Math.round(locationData.reduce((sum, l) => sum + l.utilization, 0) / locationData.length);
  const totalAppts = locationData.reduce((sum, l) => sum + l.appointmentsNext2Wk, 0);
  const totalStaff = locationData.reduce((sum, l) => sum + l.staffCount, 0);

  console.log("═".repeat(65));
  console.log("📈 PORTFOLIO SUMMARY");
  console.log("─".repeat(65));
  console.log(`\n   Your Locations:      ${locationData.length}`);
  console.log(`   Total Staff:         ${totalStaff}`);
  console.log(`   Avg Utilization:     ${avgUtil}%`);
  console.log(`   Total Appts (2wk):   ${totalAppts}`);

  // ACQUISITION TARGETS
  console.log("\n" + "═".repeat(65));
  console.log("🎯 ACQUISITION TARGET RECON");
  console.log("─".repeat(65) + "\n");

  for (const target of config.acquisitionTargets) {
    process.stdout.write(`   🔎 ${target.shortName}...`);
    try {
      const data = await analyzeLocation(target);
      const health = data.utilization >= 40 ? "🟢 Strong" : data.utilization >= 25 ? "🟡 Moderate" : "🔴 Weak";
      console.log(` ${data.utilization}% util | ${data.staffCount} staff | ${health}`);
    } catch {
      console.log(` (no data)`);
    }
  }

  // AI RECOMMENDATIONS
  console.log("\n" + "═".repeat(65));
  console.log("🧠 AI RECOMMENDATIONS");
  console.log("─".repeat(65));

  const best = locationData[0];
  const worst = locationData[locationData.length - 1];

  console.log(`\n1. 🏆 ${best.shortName} leads at ${best.utilization}% — study & replicate.`);

  if (worst.utilization < 25) {
    console.log(`\n2. ⚠️  ${worst.shortName} struggling at ${worst.utilization}% — investigate.`);
  }

  if (avgUtil >= 45) {
    console.log(`\n3. 🚀 Portfolio at ${avgUtil}% — healthy. Accelerate acquisition timeline.`);
  } else if (avgUtil < 30) {
    console.log(`\n3. 📊 Portfolio at ${avgUtil}% — focus on filling capacity before expansion.`);
  }

  console.log("\n" + "═".repeat(65));
  console.log("Run daily: npx tsx scripts/daily-brief.ts");
  console.log("═".repeat(65) + "\n");
}

generateBrief().catch(console.error);

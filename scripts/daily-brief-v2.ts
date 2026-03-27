import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import {
  getShifts,
  getAppointments,
  getAppointmentsByCreatedDate,
  getTimeblocks,
  analyzeBTBBlocks,
  DEFAULT_BTB_CONFIG,
  type StaffShift,
  type Appointment,
  type Timeblock,
} from "../lib/boulevard";
import { getAdPerformance, type PortfolioAdSummary } from "../lib/bigquery";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Obsidian output path
const OBSIDIAN_DAILY_BRIEFING_PATH = path.join(
  os.homedir(),
  "Documents/Obsidian Vault/Hello Sugar/Daily Briefing"
);

// Output buffer for Obsidian file
let outputBuffer: string[] = [];

function log(message: string = "") {
  console.log(message);
  outputBuffer.push(message);
}

function logInline(message: string) {
  process.stdout.write(message);
  // Don't add to buffer for inline progress updates
}

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

// Types
interface LocationData {
  id: string;
  shortName: string;
  utilization: number;
  appointmentsNext2Wk: number;
  staffCount: number;
  highUtilShifts: ShiftUtil[];
  lowUtilShifts: ShiftUtil[];
  capacityAlerts: string[];
  // New metrics
  bookingsYesterday: number;
  bookings7DayAvg: number;
  newClientsYesterday: number;
  btbRemovalCandidates: BTBCandidate[];
  btbAddCandidates: BTBCandidate[];
  topServices: ServiceCount[];
}

interface ShiftUtil {
  staff: string;
  day: string;
  bucket: string;
  util: number;
}

interface BTBCandidate {
  staffName: string;
  date: string;
  position: "start" | "end";
  reason: string;
}

interface ServiceCount {
  name: string;
  count: number;
}

const AM_START = 8, AM_END = 14, PM_START = 14, PM_END = 20;
const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Global staff map
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
    if (hasMore) await new Promise(r => setTimeout(r, 200));
  }

  return globalStaffMap;
}

async function getBookingVelocity(
  locationId: string,
  daysBack: number = 7
): Promise<{ yesterday: number; dailyAvg: number; newClients: number }> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - daysBack);
  const startDateStr = startDate.toISOString().split("T")[0];

  try {
    const appointments = await getAppointmentsByCreatedDate(
      locationId,
      startDateStr,
      yesterdayStr,
      1000
    );

    // Count yesterday's bookings
    const yesterdayBookings = appointments.filter(a =>
      a.createdAt?.startsWith(yesterdayStr)
    ).length;

    // Count new clients (client created same day as appointment created)
    const newClients = appointments.filter(a => {
      if (!a.createdAt || !a.client?.createdAt) return false;
      const aptCreated = a.createdAt.split("T")[0];
      const clientCreated = a.client.createdAt.split("T")[0];
      return aptCreated === clientCreated && aptCreated === yesterdayStr;
    }).length;

    // Daily average (exclude today)
    const dailyAvg = Math.round(appointments.length / daysBack);

    return { yesterday: yesterdayBookings, dailyAvg, newClients };
  } catch {
    return { yesterday: 0, dailyAvg: 0, newClients: 0 };
  }
}

async function getTopServices(
  locationId: string,
  limit: number = 5
): Promise<ServiceCount[]> {
  const apptsQuery = gql`
    query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
      appointments(locationId: $locationId, first: $first, after: $after) {
        edges {
          node {
            startAt cancelled state
            appointmentServices { service { name } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const serviceCounts = new Map<string, number>();
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const cutoffStr = twoWeeksAgo.toISOString();

  let cursor: string | null = null;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages < 10) {
    if (pages > 0) await new Promise(r => setTimeout(r, 300));

    try {
      const result = await client.request<any>(apptsQuery, {
        locationId, first: 100, after: cursor
      });

      for (const edge of result.appointments.edges) {
        const apt = edge.node;
        if (apt.cancelled || apt.state !== "FINAL") continue;
        if (apt.startAt < cutoffStr) continue;

        for (const svc of apt.appointmentServices || []) {
          if (!svc.service?.name) continue;
          const name = svc.service.name;
          serviceCounts.set(name, (serviceCounts.get(name) || 0) + 1);
        }
      }

      hasMore = result.appointments.pageInfo.hasNextPage;
      cursor = result.appointments.pageInfo.endCursor;
      pages++;
    } catch {
      break;
    }
  }

  return [...serviceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

async function analyzeBTBForLocation(
  locationId: string,
  shifts: StaffShift[],
  appointments: Appointment[],
  timeblocks: Timeblock[]
): Promise<{ removals: BTBCandidate[]; additions: BTBCandidate[] }> {
  const removals: BTBCandidate[] = [];
  const additions: BTBCandidate[] = [];

  for (const shift of shifts) {
    const staffName = shift.staffMember.displayName || shift.staffMember.name;
    if (staffName.toLowerCase().includes("training")) continue;

    const analysis = analyzeBTBBlocks(shift, appointments, timeblocks, DEFAULT_BTB_CONFIG);

    if (analysis.startBlockShouldRemove && analysis.startBlock) {
      removals.push({
        staffName,
        date: shift.date,
        position: "start",
        reason: `${analysis.startGapMinutes}min to first apt`
      });
    }

    if (analysis.endBlockShouldRemove && analysis.endBlock) {
      removals.push({
        staffName,
        date: shift.date,
        position: "end",
        reason: `${analysis.endGapMinutes}min after last apt`
      });
    }

    if (analysis.startBlockShouldAdd || analysis.startAutoAdd) {
      const gapMin = analysis.minutesToFirstAppointment ?? "no appts";
      additions.push({
        staffName,
        date: shift.date,
        position: "start",
        reason: typeof gapMin === "number" ? `${gapMin}min gap at shift start` : "no appointments, empty shift"
      });
    }

    if (analysis.endBlockShouldAdd || analysis.endAutoAdd) {
      const gapMin = analysis.minutesAfterLastAppointment ?? "no appts";
      additions.push({
        staffName,
        date: shift.date,
        position: "end",
        reason: typeof gapMin === "number" ? `${gapMin}min gap at shift end` : "no appointments, empty shift"
      });
    }
  }

  return { removals, additions };
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
            id startAt endAt duration cancelled state createdAt
            client { id createdAt }
            appointmentServices { staff { id name } service { name } duration }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  // 2 weeks forward
  const twoWeeksOut = new Date(today);
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  const twoWeeksOutStr = twoWeeksOut.toISOString().split("T")[0];

  // Fetch shifts
  const shiftsData = await client.request<any>(shiftsQuery, {
    locationId: location.id,
    startIso8601: todayStr,
    endIso8601: twoWeeksOutStr
  });

  const staffMap = await loadStaffMap();

  // Fetch all appointments
  const allAppts: any[] = [];
  let apptCursor: string | null = null;
  let hasMoreAppts = true;
  let pageCount = 0;

  while (hasMoreAppts && pageCount < 20) {
    if (pageCount > 0) await new Promise(r => setTimeout(r, 300));

    try {
      const apptsResult = await client.request<any>(apptsQuery, {
        locationId: location.id, first: 100, after: apptCursor
      });
      allAppts.push(...apptsResult.appointments.edges.map((e: any) => e.node));
      hasMoreAppts = apptsResult.appointments.pageInfo.hasNextPage;
      apptCursor = apptsResult.appointments.pageInfo.endCursor;
      pageCount++;
    } catch {
      break;
    }
  }

  const periodStart = new Date(todayStr + "T00:00:00-06:00");
  const periodEnd = new Date(twoWeeksOutStr + "T23:59:59-06:00");

  const periodAppts = allAppts.filter((a: any) => {
    const d = new Date(a.startAt);
    return d >= periodStart && d <= periodEnd && !a.cancelled;
  });

  // Fetch timeblocks for accurate utilization (exclude blocked time)
  let allTimeblocks: Timeblock[] = [];
  try {
    allTimeblocks = await getTimeblocks(location.id);
  } catch {
    // Continue without timeblocks if fetch fails
  }

  // Get booking velocity
  const velocity = await getBookingVelocity(location.id, 7);

  // Get top services
  const topServices = await getTopServices(location.id, 5);

  // Calculate utilization by AM/PM buckets (excluding blocked time)
  const bucketData = new Map<string, { staffName: string; day: number; bucket: string; availMin: number; bookedMin: number; blockedMin: number }>();

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

            // Calculate blocked time from timeblocks (lunch, DNB — but NOT BTB)
            // BTB stays as bookable capacity since it means they weren't full
            let blockedMin = 0;
            for (const tb of allTimeblocks) {
              // Skip BTB blocks — they count as available capacity
              const title = (tb.title || "").toLowerCase();
              if (title.includes("btb") || title.includes("b2b")) continue;

              // Match staff (handle URN format)
              const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
              if (tbStaffId !== shift.staffId) continue;

              const tbStart = new Date(tb.startAt).getTime();
              const tbEnd = new Date(tb.endAt).getTime();

              // Check if timeblock overlaps with this bucket
              if (tbStart < bucketEnd.getTime() && tbEnd > bucketStart.getTime()) {
                const overlapStart = Math.max(tbStart, bucketStart.getTime());
                const overlapEnd = Math.min(tbEnd, bucketEnd.getTime());
                blockedMin += (overlapEnd - overlapStart) / 60000;
              }
            }

            const key = `${shift.staffId}|${shift.day}|${bucket}`;
            if (!bucketData.has(key)) {
              bucketData.set(key, { staffName, day: shift.day, bucket, availMin: 0, bookedMin: 0, blockedMin: 0 });
            }
            bucketData.get(key)!.availMin += availMin;
            bucketData.get(key)!.bookedMin += bookedMin;
            bucketData.get(key)!.blockedMin += blockedMin;
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Calculate results (utilization = booked / (available - blocked))
  let totalAvail = 0, totalBooked = 0;
  const shiftUtils: ShiftUtil[] = [];

  for (const [_, data] of bucketData) {
    const effectiveAvail = Math.max(data.availMin - data.blockedMin, 0);
    const util = effectiveAvail > 0 ? (data.bookedMin / effectiveAvail) * 100 : 0;
    totalAvail += effectiveAvail;
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

  // BTB Analysis (simplified - just for today+7 days)
  let btbRemovalCandidates: BTBCandidate[] = [];
  let btbAddCandidates: BTBCandidate[] = [];

  try {
    const btbEndDate = new Date(today);
    btbEndDate.setDate(btbEndDate.getDate() + 7);

    const shifts = await getShifts(location.id, todayStr, btbEndDate.toISOString().split("T")[0]);
    const timeblocks = await getTimeblocks(location.id);
    const btbAnalysis = await analyzeBTBForLocation(location.id, shifts, periodAppts as Appointment[], timeblocks);
    btbRemovalCandidates = btbAnalysis.removals.slice(0, 3);
    btbAddCandidates = btbAnalysis.additions.slice(0, 3);
  } catch {
    // Skip BTB analysis on error
  }

  return {
    id: location.id,
    shortName: location.shortName,
    utilization: overallUtil,
    appointmentsNext2Wk: periodAppts.length,
    staffCount: uniqueStaff.size,
    highUtilShifts,
    lowUtilShifts,
    capacityAlerts,
    bookingsYesterday: velocity.yesterday,
    bookings7DayAvg: velocity.dailyAvg,
    newClientsYesterday: velocity.newClients,
    btbRemovalCandidates,
    btbAddCandidates,
    topServices,
  };
}

async function generateBrief() {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Denver"
  });

  log("\n" + "═".repeat(70));
  log("🧠 HELLO SUGAR UTAH — DAILY AI OPERATIONS BRIEF v2");
  log(`📅 ${dateStr}`);
  log("═".repeat(70));

  log("\nLoading staff directory...");
  await loadStaffMap();
  log(`✓ Loaded ${globalStaffMap?.size || 0} staff members`);

  log("\nAnalyzing your 7 locations...\n");

  const locationData: LocationData[] = [];

  for (const loc of config.owned) {
    logInline(`  📍 ${loc.shortName}...`);
    try {
      const data = await analyzeLocation(loc);
      locationData.push(data);
      log(` ✓`);
    } catch (e: any) {
      log(` ✗ (${e.message?.slice(0, 30)})`);
    }
  }

  if (locationData.length === 0) {
    log("\n⚠️  Could not analyze any locations. Check API credentials.");
    return;
  }

  locationData.sort((a, b) => b.utilization - a.utilization);

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 1: BOOKING VELOCITY
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("📈 BOOKING VELOCITY (yesterday vs. 7-day avg)");
  log("─".repeat(70));

  const totalYesterday = locationData.reduce((sum, l) => sum + l.bookingsYesterday, 0);
  const totalAvg = locationData.reduce((sum, l) => sum + l.bookings7DayAvg, 0);
  const totalNewClients = locationData.reduce((sum, l) => sum + l.newClientsYesterday, 0);
  const velocityDelta = totalAvg > 0 ? Math.round((totalYesterday / totalAvg - 1) * 100) : 0;

  log(`\n   📊 Portfolio: ${totalYesterday} bookings yesterday (${velocityDelta >= 0 ? "+" : ""}${velocityDelta}% vs avg)`);
  log(`   🆕 New clients: ${totalNewClients}`);
  log("");

  for (const loc of locationData) {
    const delta = loc.bookings7DayAvg > 0 ? Math.round((loc.bookingsYesterday / loc.bookings7DayAvg - 1) * 100) : 0;
    const indicator = delta >= 20 ? "🚀" : delta >= 0 ? "✓" : delta >= -20 ? "⚠️" : "🔴";
    log(`   ${indicator} ${loc.shortName.padEnd(14)} ${loc.bookingsYesterday} bookings (${delta >= 0 ? "+" : ""}${delta}% vs avg) | ${loc.newClientsYesterday} new clients`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 2: ADVERTISING PERFORMANCE
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("📣 ADVERTISING PERFORMANCE (last 7 days)");
  log("─".repeat(70));

  let adData: PortfolioAdSummary | null = null;
  try {
    const shortNames = config.owned.map((l: any) => l.shortName);
    adData = await getAdPerformance(shortNames, 7);

    log(`\n   📊 Portfolio: $${adData.totalSpend.toFixed(0)} spent | ${adData.totalBookings} bookings | $${adData.overallCPB.toFixed(2)} CPB`);
    log(`      Google: $${adData.totalGoogleSpend.toFixed(0)} → ${adData.totalGoogleBookings} bkgs ($${adData.googleCPB.toFixed(2)} CPB)`);
    log(`      Meta:   $${adData.totalMetaSpend.toFixed(0)} → ${adData.totalMetaBookings} bkgs ($${adData.metaCPB.toFixed(2)} CPB)`);
    log("");

    // Location breakdown table
    log("   Location        Google Ads              Meta Ads");
    log("   " + "─".repeat(60));

    for (const loc of adData.locations.sort((a, b) => b.google.spend - a.google.spend)) {
      const gStr = loc.google.bookings > 0
        ? `$${loc.google.spend.toFixed(0).padStart(4)} | ${String(loc.google.bookings).padStart(2)} bkgs | $${loc.google.costPerBooking.toFixed(2)}`
        : `$${loc.google.spend.toFixed(0).padStart(4)} | -- bkgs | --`;
      const mStr = loc.meta.bookings > 0
        ? `$${loc.meta.spend.toFixed(1)} | ${loc.meta.bookings} bkgs`
        : `$${loc.meta.spend.toFixed(1)} | --`;
      log(`   ${loc.shortName.padEnd(14)} ${gStr.padEnd(28)} ${mStr}`);
    }

    // Alerts
    if (adData.alerts.length > 0) {
      log("\n   ⚠️  Alerts:");
      for (const alert of adData.alerts) {
        log(`      • ${alert}`);
      }
    }
  } catch (err: any) {
    log(`\n   ⚠️  Could not fetch ad data: ${err.message?.slice(0, 50)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 3: URGENT CAPACITY ALERTS
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("🔴 URGENT — CAPACITY ALERTS (≥75% booked)");
  log("─".repeat(70));

  let urgentCount = 0;
  for (const loc of locationData) {
    for (const alert of loc.capacityAlerts) {
      urgentCount++;
      log(`\n${urgentCount}. [${loc.shortName}] ${alert}`);
      log(`   → Add coverage or open waitlist?`);
    }
  }
  if (urgentCount === 0) log("\n   ✓ No urgent capacity issues.");

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 4: GROWTH OPPORTUNITIES
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("🟡 GROWTH OPPORTUNITIES (shifts ≥50% booked)");
  log("─".repeat(70));

  let oppCount = 0;
  for (const loc of locationData) {
    for (const shift of loc.highUtilShifts.slice(0, 3)) {
      oppCount++;
      log(`\n${oppCount}. [${loc.shortName}] ${shift.staff} — ${shift.day} ${shift.bucket}: ${shift.util}%`);
      log(`   → Consider adding second aesthetician`);
    }
  }
  if (oppCount === 0) log("\n   No high-utilization shifts yet.");

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 5: BTB MANAGEMENT RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("⏰ BTB MANAGEMENT (next 7 days)");
  log("─".repeat(70));

  // Deduplicate by staff+date+position
  const dedupeKey = (c: any) => `${c.location}|${c.staffName}|${c.date}|${c.position}`;
  const seenRemovals = new Set<string>();
  const seenAdditions = new Set<string>();

  const allRemovals = locationData.flatMap(l => l.btbRemovalCandidates.map(c => ({ ...c, location: l.shortName })))
    .filter(c => { const k = dedupeKey(c); if (seenRemovals.has(k)) return false; seenRemovals.add(k); return true; });
  const allAdditions = locationData.flatMap(l => l.btbAddCandidates.map(c => ({ ...c, location: l.shortName })))
    .filter(c => { const k = dedupeKey(c); if (seenAdditions.has(k)) return false; seenAdditions.add(k); return true; });

  if (allRemovals.length > 0) {
    log("\n   🔓 REMOVE BTB (shift is filling up):");
    for (const r of allRemovals.slice(0, 5)) {
      log(`      [${r.location}] ${r.staffName} ${r.date} ${r.position} - ${r.reason}`);
    }
  }

  if (allAdditions.length > 0) {
    log("\n   🔒 ADD BTB (large gaps to fill):");
    for (const a of allAdditions.slice(0, 5)) {
      log(`      [${a.location}] ${a.staffName} ${a.date} ${a.position} - ${a.reason}`);
    }
  }

  if (allRemovals.length === 0 && allAdditions.length === 0) {
    log("\n   ✓ No BTB changes recommended.");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6: UNDERUTILIZED SHIFTS
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "─".repeat(70));
  log("💤 UNDERUTILIZED (consider cutting or running promos)");

  for (const loc of locationData) {
    const low = loc.lowUtilShifts.filter(s => s.util < 15);
    if (low.length > 0) {
      log(`\n   [${loc.shortName}]`);
      for (const s of low.slice(0, 3)) {
        log(`   • ${s.staff} ${s.day} ${s.bucket}: only ${s.util}%`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 7: TOP SERVICES
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("💅 TOP SERVICES (last 2 weeks by location)");
  log("─".repeat(70));

  for (const loc of locationData.slice(0, 4)) {
    if (loc.topServices.length > 0) {
      log(`\n   [${loc.shortName}]`);
      for (const svc of loc.topServices.slice(0, 3)) {
        log(`   • ${svc.name}: ${svc.count}x`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 8: LOCATION LEADERBOARD
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("📊 LOCATION LEADERBOARD (next 2 weeks forecast)");
  log("─".repeat(70) + "\n");

  for (let i = 0; i < locationData.length; i++) {
    const loc = locationData[i];
    const bar = "█".repeat(Math.round(loc.utilization / 5)) + "░".repeat(20 - Math.round(loc.utilization / 5));
    const emoji = loc.utilization >= 40 ? "🟢" : loc.utilization >= 25 ? "🟡" : "🔴";

    log(`${i + 1}. ${emoji} ${loc.shortName.padEnd(14)} ${bar} ${String(loc.utilization).padStart(2)}%`);
    log(`      ${loc.staffCount} staff | ${loc.appointmentsNext2Wk} appts booked\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 9: PORTFOLIO SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  const avgUtil = Math.round(locationData.reduce((sum, l) => sum + l.utilization, 0) / locationData.length);
  const totalAppts = locationData.reduce((sum, l) => sum + l.appointmentsNext2Wk, 0);
  const totalStaff = locationData.reduce((sum, l) => sum + l.staffCount, 0);

  log("═".repeat(70));
  log("📈 PORTFOLIO SUMMARY");
  log("─".repeat(70));
  log(`\n   Your Locations:      ${locationData.length}`);
  log(`   Total Staff:         ${totalStaff}`);
  log(`   Avg Utilization:     ${avgUtil}%`);
  log(`   Total Appts (2wk):   ${totalAppts}`);
  log(`   Yesterday Bookings:  ${totalYesterday} (${velocityDelta >= 0 ? "+" : ""}${velocityDelta}% vs avg)`);
  log(`   New Clients:         ${totalNewClients}`);

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 10: ACQUISITION TARGETS (disabled - too slow for daily brief)
  // ═══════════════════════════════════════════════════════════════════════
  // Run separately with: npx tsx scripts/analyze-acquisition-targets.ts
  // for (const target of config.acquisitionTargets) { ... }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 11: AI RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "═".repeat(70));
  log("🧠 AI RECOMMENDATIONS");
  log("─".repeat(70));

  const best = locationData[0];
  const worst = locationData[locationData.length - 1];
  let recNum = 0;

  // Booking velocity insight
  if (velocityDelta < -20) {
    recNum++;
    log(`\n${recNum}. 📉 Bookings down ${Math.abs(velocityDelta)}% yesterday — run a flash promo or check marketing.`);
  } else if (velocityDelta > 30) {
    recNum++;
    log(`\n${recNum}. 🚀 Bookings up ${velocityDelta}% yesterday — momentum is strong. Push marketing harder.`);
  }

  // Top performer
  recNum++;
  log(`\n${recNum}. 🏆 ${best.shortName} leads at ${best.utilization}% — replicate what's working there.`);

  // Struggling location
  if (worst.utilization < 25) {
    recNum++;
    log(`\n${recNum}. ⚠️  ${worst.shortName} struggling at ${worst.utilization}% — investigate root cause.`);
  }

  // Capacity pressure
  if (urgentCount >= 3) {
    recNum++;
    log(`\n${recNum}. 🔥 ${urgentCount} capacity alerts — prioritize hiring or extending hours.`);
  }

  // New client acquisition
  if (totalNewClients > 10) {
    recNum++;
    log(`\n${recNum}. 🆕 ${totalNewClients} new clients yesterday — strong acquisition. Ensure rebooking.`);
  } else if (totalNewClients < 3) {
    recNum++;
    log(`\n${recNum}. 🆕 Only ${totalNewClients} new clients yesterday — boost marketing to new audiences.`);
  }

  // Portfolio health
  if (avgUtil >= 45) {
    recNum++;
    log(`\n${recNum}. 📊 Portfolio at ${avgUtil}% — healthy. Accelerate acquisition timeline.`);
  } else if (avgUtil < 30) {
    recNum++;
    log(`\n${recNum}. 📊 Portfolio at ${avgUtil}% — focus on filling capacity before expansion.`);
  }

  // Advertising insights
  if (adData) {
    if (adData.overallCPB > 25) {
      recNum++;
      log(`\n${recNum}. 💰 Ad CPB at $${adData.overallCPB.toFixed(2)} — above $25 target. Review underperforming campaigns.`);
    } else if (adData.overallCPB < 15 && adData.totalBookings > 50) {
      recNum++;
      log(`\n${recNum}. 🚀 Ad CPB at $${adData.overallCPB.toFixed(2)} — efficient! Consider increasing spend.`);
    }
    if (adData.totalMetaSpend < 10) {
      recNum++;
      log(`\n${recNum}. 📱 Meta spend is near zero — is this intentional or an issue?`);
    }
  }

  log("\n" + "═".repeat(70));
  log("Run daily: npx tsx scripts/daily-brief-v2.ts");
  log("═".repeat(70) + "\n");

  // Save to Obsidian
  try {
    const dateForFile = today.toISOString().split("T")[0]; // YYYY-MM-DD
    const obsidianFile = path.join(OBSIDIAN_DAILY_BRIEFING_PATH, `${dateForFile}.md`);

    // Ensure directory exists
    if (!fs.existsSync(OBSIDIAN_DAILY_BRIEFING_PATH)) {
      fs.mkdirSync(OBSIDIAN_DAILY_BRIEFING_PATH, { recursive: true });
    }

    // Add frontmatter and save
    const content = `---
date: ${dateForFile}
type: daily-briefing
tags: [hello-sugar, operations, utah]
---

\`\`\`
${outputBuffer.join("\n")}
\`\`\`
`;
    fs.writeFileSync(obsidianFile, content);
    console.log(`📁 Saved to Obsidian: ${obsidianFile}`);
  } catch (err: any) {
    console.error(`⚠️  Could not save to Obsidian: ${err.message}`);
  }
}

generateBrief().catch(console.error);

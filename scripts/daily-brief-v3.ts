import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { BigQuery } from "@google-cloud/bigquery";
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

// BigQuery client
const bigquery = new BigQuery({ projectId: "even-affinity-388602" });
const DATASET = "snowflake_data";

// BLVD client (only for shifts)
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
  return `Basic ${Buffer.from(`${apiKey}:${signature}${payload}`, "utf8").toString("base64")}`;
}

const blvdClient = new GraphQLClient(BLVD_API_URL, {
  headers: { Authorization: generateAuthHeader() }
});

// Load location config
const configPath = path.join(__dirname, "../config/utah-locations.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// BQ location name mapping
const LOCATION_NAME_MAP: Record<string, string> = {
  "Bountiful": "UT Bountiful | Colonial Square 042",
  "Farmington": "UT Farmington | Farmington Station 227",
  "Heber City": "UT Heber City | Valley Station 236",
  "Ogden": "UT Ogden | Riverdale 082",
  "Riverton": "UT Riverton | Mountain View Village 237",
  "Sugar House": "UT Salt Lake City | Sugar House 126",
  "West Valley": "UT West Valley | Valley Fair 176",
};

interface LocationData {
  shortName: string;
  bqName: string;
  blvdId: string;
  // Utilization (from BLVD shifts + BQ appointments)
  utilization: number;
  scheduledMinutes: number;
  bookedMinutes: number;
  // From BQ
  upcomingAppts: number;
  staffCount: number;
  bookingsYesterday: number;
  bookings7DayAvg: number;
  newClientsYesterday: number;
  // MoM comparison
  mtdAppts: number;
  lmAppts: number;
  apptsChange: number | null;
  mtdNew: number;
  lmNew: number;
  newChange: number | null;
  mtdReturning: number;
  lmReturning: number;
  // Capacity alerts
  highUtilShifts: { staff: string; day: string; bucket: string; util: number }[];
  capacityAlerts: string[];
  // Staff MCR
  staffMcr: { name: string; newClients: number; memberships: number; mcr: number }[];
  // Top services
  topServices: { name: string; count: number }[];
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ═══════════════════════════════════════════════════════════════════════════
// BQ DATA FETCHING (FAST)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBQData() {
  // Run all BQ queries in parallel
  const [
    bookingVelocityRows,
    momComparisonRows,
    staffMcrRows,
    upcomingApptsRows,
    topServicesRows,
  ] = await Promise.all([
    // Booking velocity (yesterday + 7-day avg)
    bigquery.query({
      query: `
        WITH daily AS (
          SELECT
            _COL_1 as location,
            _COL_0 as date,
            SUM(CAST(_COL_5 AS INT64)) as appts,
            SUM(CAST(_COL_8 AS INT64)) as new_clients
          FROM \`${DATASET}.tbl_mcr_data_agg\`
          WHERE _COL_1 LIKE 'UT %'
            AND _COL_0 >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
          GROUP BY 1, 2
        )
        SELECT
          location,
          SUM(CASE WHEN date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) THEN appts ELSE 0 END) as yesterday_appts,
          SUM(CASE WHEN date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) THEN new_clients ELSE 0 END) as yesterday_new,
          ROUND(AVG(appts), 0) as avg_appts
        FROM daily
        GROUP BY 1
      `
    }),

    // MoM comparison
    bigquery.query({
      query: `
        WITH this_month AS (
          SELECT
            _COL_1 as location,
            SUM(CAST(_COL_5 AS INT64)) as total_appts,
            SUM(CAST(_COL_8 AS INT64)) as new_clients,
            SUM(CAST(_COL_11 AS INT64)) as returning_clients
          FROM \`${DATASET}.tbl_mcr_data_agg\`
          WHERE _COL_1 LIKE 'UT %'
            AND _COL_0 >= DATE_TRUNC(CURRENT_DATE(), MONTH)
          GROUP BY 1
        ),
        last_month AS (
          SELECT
            _COL_1 as location,
            SUM(CAST(_COL_5 AS INT64)) as total_appts,
            SUM(CAST(_COL_8 AS INT64)) as new_clients,
            SUM(CAST(_COL_11 AS INT64)) as returning_clients
          FROM \`${DATASET}.tbl_mcr_data_agg\`
          WHERE _COL_1 LIKE 'UT %'
            AND _COL_0 >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 1 MONTH)
            AND _COL_0 < DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH)
          GROUP BY 1
        )
        SELECT
          t.location,
          t.total_appts as mtd_appts, l.total_appts as lm_appts,
          ROUND((t.total_appts - l.total_appts) / NULLIF(l.total_appts, 0) * 100, 0) as appts_chg,
          t.new_clients as mtd_new, l.new_clients as lm_new,
          ROUND((t.new_clients - l.new_clients) / NULLIF(l.new_clients, 0) * 100, 0) as new_chg,
          t.returning_clients as mtd_ret, l.returning_clients as lm_ret
        FROM this_month t
        LEFT JOIN last_month l ON t.location = l.location
      `
    }),

    // Staff MCR% MTD
    bigquery.query({
      query: `
        SELECT
          _COL_1 as location,
          _COL_3 as staff,
          SUM(CAST(_COL_8 AS INT64)) as new_clients,
          SUM(CAST(_COL_9 AS INT64)) as memberships,
          ROUND(SAFE_DIVIDE(SUM(CAST(_COL_9 AS INT64)), SUM(CAST(_COL_8 AS INT64))) * 100, 0) as mcr_pct
        FROM \`${DATASET}.tbl_mcr_data_agg\`
        WHERE _COL_1 LIKE 'UT %'
          AND _COL_0 >= DATE_TRUNC(CURRENT_DATE(), MONTH)
        GROUP BY 1, 2
        HAVING SUM(CAST(_COL_8 AS INT64)) > 0
      `
    }),

    // Upcoming appointments (next 2 weeks)
    bigquery.query({
      query: `
        SELECT
          _COL_4 as location,
          _COL_9 as staff,
          _COL_0 as appt_date,
          EXTRACT(HOUR FROM TIMESTAMP(_COL_7)) as start_hour,
          CAST(_COL_2 AS INT64) as duration_min
        FROM \`${DATASET}.tbl_booked_detailed\`
        WHERE _COL_4 LIKE 'UT %'
          AND _COL_0 >= CURRENT_DATE()
          AND _COL_0 <= DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY)
      `
    }),

    // Top services (last 2 weeks)
    bigquery.query({
      query: `
        SELECT
          _COL_17 as location,
          _COL_22 as services,
          COUNT(*) as count
        FROM \`${DATASET}.tbl_adhoc_all_completed_bookings\`
        WHERE _COL_17 LIKE 'UT %'
          AND _COL_28 >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
        GROUP BY 1, 2
        ORDER BY 1, 3 DESC
      `
    }),
  ]);

  return {
    bookingVelocity: bookingVelocityRows[0] as any[],
    momComparison: momComparisonRows[0] as any[],
    staffMcr: staffMcrRows[0] as any[],
    upcomingAppts: upcomingApptsRows[0] as any[],
    topServices: topServicesRows[0] as any[],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLVD SHIFTS FETCHING (for utilization - small/fast)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchShiftsForLocation(locationId: string, startDate: string, endDate: string) {
  const shiftsQuery = gql`
    query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
      shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
        shifts { staffId day clockIn clockOut available recurrenceStart recurrenceEnd }
      }
    }
  `;

  try {
    const result = await blvdClient.request<any>(shiftsQuery, {
      locationId,
      startIso8601: startDate,
      endIso8601: endDate
    });
    return result.shifts.shifts || [];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIZATION CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

function calculateUtilization(
  shifts: any[],
  upcomingAppts: any[],
  locationBqName: string,
  periodStart: Date,
  periodEnd: Date
) {
  const AM_START = 8, AM_END = 14, PM_START = 14, PM_END = 20;

  // Build scheduled minutes by staff/day/bucket
  const bucketData = new Map<string, { staff: string; day: number; bucket: string; scheduledMin: number; bookedMin: number }>();

  for (const shift of shifts) {
    if (!shift.staffId || !shift.available) continue;

    const recStart = shift.recurrenceStart ? new Date(shift.recurrenceStart + "T00:00:00-06:00") : periodStart;
    const recEnd = shift.recurrenceEnd ? new Date(shift.recurrenceEnd + "T23:59:59-06:00") : periodEnd;

    let d = new Date(periodStart);
    while (d <= periodEnd) {
      if (d.getDay() === shift.day && d >= recStart && d <= recEnd) {
        const [h1, m1] = shift.clockIn.split(":").map(Number);
        const [h2, m2] = shift.clockOut.split(":").map(Number);
        const shiftStartHour = h1 + m1/60;
        const shiftEndHour = h2 + m2/60;

        for (const bucket of ["AM", "PM"] as const) {
          const bStart = bucket === "AM" ? AM_START : PM_START;
          const bEnd = bucket === "AM" ? AM_END : PM_END;

          if (shiftStartHour < bEnd && shiftEndHour > bStart) {
            const overlapStart = Math.max(bStart, shiftStartHour);
            const overlapEnd = Math.min(bEnd, shiftEndHour);
            const scheduledMin = (overlapEnd - overlapStart) * 60;

            if (scheduledMin > 0) {
              const key = `${shift.staffId}|${shift.day}|${bucket}`;
              if (!bucketData.has(key)) {
                bucketData.set(key, { staff: shift.staffId, day: shift.day, bucket, scheduledMin: 0, bookedMin: 0 });
              }
              bucketData.get(key)!.scheduledMin += scheduledMin;
            }
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Add booked minutes from BQ data
  const locationAppts = upcomingAppts.filter((a: any) => a.location === locationBqName);

  for (const appt of locationAppts) {
    // BQ returns dates as { value: "YYYY-MM-DD" }
    const dateStr = appt.appt_date?.value || appt.appt_date;
    const apptDate = new Date(dateStr + "T12:00:00");
    if (apptDate < periodStart || apptDate > periodEnd) continue;

    const dayOfWeek = apptDate.getDay();
    const hour = Number(appt.start_hour);
    const bucket = hour < 14 ? "AM" : "PM";
    const duration = Number(appt.duration_min) || 0;

    // Find matching bucket (we don't have staff ID mapping, so just add to first matching day/bucket)
    for (const [_, data] of bucketData) {
      if (data.day === dayOfWeek && data.bucket === bucket) {
        data.bookedMin += duration;
        break;
      }
    }
  }

  // Calculate results
  let totalScheduled = 0, totalBooked = 0;
  const shiftUtils: { staff: string; day: string; bucket: string; util: number }[] = [];

  for (const [_, data] of bucketData) {
    const util = data.scheduledMin > 0 ? (data.bookedMin / data.scheduledMin) * 100 : 0;
    totalScheduled += data.scheduledMin;
    totalBooked += data.bookedMin;

    if (data.scheduledMin > 60) { // Only include shifts > 1 hour
      shiftUtils.push({
        staff: data.staff,
        day: dayNames[data.day],
        bucket: data.bucket === "AM" ? "8AM-2PM" : "2PM-8PM",
        util: Math.round(util)
      });
    }
  }

  return {
    utilization: totalScheduled > 0 ? Math.round((totalBooked / totalScheduled) * 100) : 0,
    scheduledMinutes: totalScheduled,
    bookedMinutes: totalBooked,
    highUtilShifts: shiftUtils.filter(s => s.util >= 50).sort((a, b) => b.util - a.util).slice(0, 5),
    capacityAlerts: shiftUtils.filter(s => s.util >= 75).map(s => `${s.staff} is ${s.util}% booked ${s.day} ${s.bucket}`)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN BRIEF GENERATION
// ═══════════════════════════════════════════════════════════════════════════

async function generateBrief() {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Denver"
  });
  const todayStr = today.toISOString().split("T")[0];

  const twoWeeksOut = new Date(today);
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  const twoWeeksOutStr = twoWeeksOut.toISOString().split("T")[0];

  log("\n" + "=".repeat(70));
  log("HELLO SUGAR UTAH - DAILY OPERATIONS BRIEF v3");
  log(`${dateStr}`);
  log("=".repeat(70));

  // Fetch all BQ data in parallel (fast)
  log("\nFetching data from BigQuery...");
  const bqData = await fetchBQData();
  log(`Done - ${bqData.upcomingAppts.length} upcoming appointments loaded`);

  // Fetch shifts from BLVD in parallel (for utilization)
  log("Fetching shifts from Boulevard (parallel)...");
  const periodStart = new Date(todayStr + "T00:00:00-06:00");
  const periodEnd = new Date(twoWeeksOutStr + "T23:59:59-06:00");

  const shiftsPromises = config.owned.map((loc: any) =>
    fetchShiftsForLocation(loc.id, todayStr, twoWeeksOutStr).then(shifts => ({
      shortName: loc.shortName,
      blvdId: loc.id,
      shifts
    }))
  );
  const allShifts = await Promise.all(shiftsPromises);
  const totalShifts = allShifts.reduce((sum, l) => sum + l.shifts.length, 0);
  log(`Done - ${allShifts.length} locations, ${totalShifts} shift templates loaded`);

  // Build location data
  const locationData: LocationData[] = [];

  for (const locShifts of allShifts) {
    const bqName = LOCATION_NAME_MAP[locShifts.shortName];
    if (!bqName) continue;

    // Utilization from shifts + BQ appointments
    const utilData = calculateUtilization(
      locShifts.shifts,
      bqData.upcomingAppts,
      bqName,
      periodStart,
      periodEnd
    );

    // Booking velocity from BQ
    const velocity = bqData.bookingVelocity.find((v: any) => v.location === bqName) || {};

    // MoM comparison from BQ
    const mom = bqData.momComparison.find((m: any) => m.location === bqName) || {};

    // Staff MCR from BQ
    const staffMcr = bqData.staffMcr
      .filter((s: any) => s.location === bqName)
      .map((s: any) => ({
        name: s.staff,
        newClients: Number(s.new_clients),
        memberships: Number(s.memberships),
        mcr: Number(s.mcr_pct) || 0
      }))
      .sort((a: any, b: any) => b.mcr - a.mcr);

    // Top services from BQ
    const topServices = bqData.topServices
      .filter((s: any) => s.location === bqName)
      .slice(0, 5)
      .map((s: any) => ({ name: s.services, count: Number(s.count) }));

    // Upcoming appointments count
    const upcomingAppts = bqData.upcomingAppts.filter((a: any) => a.location === bqName).length;

    // Staff count (unique staff with appointments)
    const staffCount = new Set(bqData.upcomingAppts.filter((a: any) => a.location === bqName).map((a: any) => a.staff)).size;

    locationData.push({
      shortName: locShifts.shortName,
      bqName,
      blvdId: locShifts.blvdId,
      utilization: utilData.utilization,
      scheduledMinutes: utilData.scheduledMinutes,
      bookedMinutes: utilData.bookedMinutes,
      upcomingAppts,
      staffCount: staffCount || staffMcr.length,
      bookingsYesterday: Number(velocity.yesterday_appts) || 0,
      bookings7DayAvg: Number(velocity.avg_appts) || 0,
      newClientsYesterday: Number(velocity.yesterday_new) || 0,
      mtdAppts: Number(mom.mtd_appts) || 0,
      lmAppts: Number(mom.lm_appts) || 0,
      apptsChange: mom.appts_chg != null ? Number(mom.appts_chg) : null,
      mtdNew: Number(mom.mtd_new) || 0,
      lmNew: Number(mom.lm_new) || 0,
      newChange: mom.new_chg != null ? Number(mom.new_chg) : null,
      mtdReturning: Number(mom.mtd_ret) || 0,
      lmReturning: Number(mom.lm_ret) || 0,
      highUtilShifts: utilData.highUtilShifts,
      capacityAlerts: utilData.capacityAlerts,
      staffMcr,
      topServices,
    });
  }

  locationData.sort((a, b) => b.utilization - a.utilization);

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 1: BOOKING VELOCITY
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("BOOKING VELOCITY (yesterday vs. 7-day avg)");
  log("-".repeat(70));

  const totalYesterday = locationData.reduce((sum, l) => sum + l.bookingsYesterday, 0);
  const totalAvg = locationData.reduce((sum, l) => sum + l.bookings7DayAvg, 0);
  const totalNewClients = locationData.reduce((sum, l) => sum + l.newClientsYesterday, 0);
  const velocityDelta = totalAvg > 0 ? Math.round((totalYesterday / totalAvg - 1) * 100) : 0;

  log(`\n   Portfolio: ${totalYesterday} bookings yesterday (${velocityDelta >= 0 ? "+" : ""}${velocityDelta}% vs avg)`);
  log(`   New clients: ${totalNewClients}`);
  log("");

  for (const loc of locationData) {
    const delta = loc.bookings7DayAvg > 0 ? Math.round((loc.bookingsYesterday / loc.bookings7DayAvg - 1) * 100) : 0;
    const indicator = delta >= 20 ? "[UP]" : delta >= 0 ? "[OK]" : delta >= -20 ? "[!]" : "[DOWN]";
    log(`   ${indicator} ${loc.shortName.padEnd(14)} ${loc.bookingsYesterday} bookings (${delta >= 0 ? "+" : ""}${delta}% vs avg) | ${loc.newClientsYesterday} new`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 2: MONTH OVER MONTH COMPARISON
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("MONTH OVER MONTH (MTD vs same period last month)");
  log("-".repeat(70));

  const dayOfMonth = today.getDate();
  log(`\n   Comparing first ${dayOfMonth} days of month\n`);

  log("   Location        Appts       New Clients    Returning");
  log("   " + "-".repeat(60));

  for (const loc of locationData.sort((a, b) => b.mtdAppts - a.mtdAppts)) {
    const apptsStr = loc.apptsChange != null
      ? `${loc.mtdAppts} (${loc.apptsChange >= 0 ? "+" : ""}${loc.apptsChange}%)`
      : `${loc.mtdAppts}`;
    const newStr = loc.newChange != null
      ? `${loc.mtdNew} (${loc.newChange >= 0 ? "+" : ""}${loc.newChange}%)`
      : `${loc.mtdNew}`;
    const retStr = `${loc.mtdReturning}`;

    log(`   ${loc.shortName.padEnd(14)} ${apptsStr.padEnd(12)} ${newStr.padEnd(15)} ${retStr}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 3: ADVERTISING PERFORMANCE
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("ADVERTISING PERFORMANCE (last 7 days)");
  log("-".repeat(70));

  let adData: PortfolioAdSummary | null = null;
  try {
    const shortNames = config.owned.map((l: any) => l.shortName);
    adData = await getAdPerformance(shortNames, 7);

    log(`\n   Portfolio: $${adData.totalSpend.toFixed(0)} spent | ${adData.totalBookings} bookings | $${adData.overallCPB.toFixed(2)} CPB`);
    log(`      Google: $${adData.totalGoogleSpend.toFixed(0)} -> ${adData.totalGoogleBookings} bkgs ($${adData.googleCPB.toFixed(2)} CPB)`);
    log(`      Meta:   $${adData.totalMetaSpend.toFixed(0)} -> ${adData.totalMetaBookings} bkgs ($${adData.metaCPB.toFixed(2)} CPB)`);
    log("");

    log("   Location        Google Ads              Meta Ads");
    log("   " + "-".repeat(60));

    for (const loc of adData.locations.sort((a, b) => b.google.spend - a.google.spend)) {
      const gStr = loc.google.bookings > 0
        ? `$${loc.google.spend.toFixed(0).padStart(4)} | ${String(loc.google.bookings).padStart(2)} bkgs | $${loc.google.costPerBooking.toFixed(2)}`
        : `$${loc.google.spend.toFixed(0).padStart(4)} | -- bkgs | --`;
      const mStr = loc.meta.bookings > 0
        ? `$${loc.meta.spend.toFixed(1)} | ${loc.meta.bookings} bkgs`
        : `$${loc.meta.spend.toFixed(1)} | --`;
      log(`   ${loc.shortName.padEnd(14)} ${gStr.padEnd(28)} ${mStr}`);
    }

    if (adData.alerts.length > 0) {
      log("\n   Alerts:");
      for (const alert of adData.alerts) {
        log(`      * ${alert}`);
      }
    }
  } catch (err: any) {
    log(`\n   Could not fetch ad data: ${err.message?.slice(0, 50)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 4: CAPACITY ALERTS
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("CAPACITY ALERTS (>=75% booked)");
  log("-".repeat(70));

  let alertCount = 0;
  for (const loc of locationData) {
    for (const alert of loc.capacityAlerts) {
      alertCount++;
      log(`\n${alertCount}. [${loc.shortName}] ${alert}`);
      log(`   -> Add coverage or open waitlist?`);
    }
  }
  if (alertCount === 0) log("\n   No urgent capacity issues.");

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 5: GROWTH OPPORTUNITIES
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("GROWTH OPPORTUNITIES (shifts >=50% booked)");
  log("-".repeat(70));

  let oppCount = 0;
  for (const loc of locationData) {
    for (const shift of loc.highUtilShifts.filter(s => s.util >= 50 && s.util < 75).slice(0, 2)) {
      oppCount++;
      log(`\n${oppCount}. [${loc.shortName}] ${shift.day} ${shift.bucket}: ${shift.util}%`);
      log(`   -> Consider adding second aesthetician`);
    }
  }
  if (oppCount === 0) log("\n   No high-utilization shifts yet.");

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6: STAFF MCR% (MTD)
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("STAFF MCR% (Month-to-Date)");
  log("-".repeat(70));

  for (const loc of locationData.filter(l => l.staffMcr.length > 0).slice(0, 5)) {
    log(`\n   [${loc.shortName}]`);
    for (const staff of loc.staffMcr.slice(0, 4)) {
      const bar = staff.mcr >= 50 ? "[HIGH]" : staff.mcr >= 25 ? "[OK]" : "[LOW]";
      log(`   ${bar} ${staff.name.slice(0, 20).padEnd(22)} ${staff.mcr}% MCR (${staff.memberships}/${staff.newClients} new)`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 7: LOCATION LEADERBOARD
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("LOCATION LEADERBOARD (next 2 weeks forecast)");
  log("-".repeat(70) + "\n");

  locationData.sort((a, b) => b.utilization - a.utilization);

  for (let i = 0; i < locationData.length; i++) {
    const loc = locationData[i];
    const barLen = Math.round(loc.utilization / 5);
    const bar = "#".repeat(barLen) + ".".repeat(20 - barLen);
    const status = loc.utilization >= 40 ? "[GOOD]" : loc.utilization >= 25 ? "[OK]" : "[LOW]";

    log(`${i + 1}. ${status} ${loc.shortName.padEnd(14)} ${bar} ${String(loc.utilization).padStart(2)}%`);
    log(`      ${loc.staffCount} staff | ${loc.upcomingAppts} appts booked\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 8: TOP SERVICES
  // ═══════════════════════════════════════════════════════════════════════
  log("=".repeat(70));
  log("TOP SERVICES (last 2 weeks)");
  log("-".repeat(70));

  for (const loc of locationData.filter(l => l.topServices.length > 0).slice(0, 4)) {
    log(`\n   [${loc.shortName}]`);
    for (const svc of loc.topServices.slice(0, 3)) {
      log(`   * ${svc.name}: ${svc.count}x`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 9: AI RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════
  log("\n" + "=".repeat(70));
  log("AI RECOMMENDATIONS");
  log("-".repeat(70));

  const avgUtil = Math.round(locationData.reduce((sum, l) => sum + l.utilization, 0) / locationData.length);
  const best = locationData[0];
  const worst = locationData[locationData.length - 1];
  let recNum = 0;

  if (velocityDelta < -20) {
    recNum++;
    log(`\n${recNum}. Bookings down ${Math.abs(velocityDelta)}% yesterday - run a flash promo or check marketing.`);
  } else if (velocityDelta > 30) {
    recNum++;
    log(`\n${recNum}. Bookings up ${velocityDelta}% yesterday - momentum is strong. Push marketing harder.`);
  }

  recNum++;
  log(`\n${recNum}. ${best.shortName} leads at ${best.utilization}% utilization - replicate what's working there.`);

  if (worst.utilization < 25) {
    recNum++;
    log(`\n${recNum}. ${worst.shortName} struggling at ${worst.utilization}% - investigate root cause.`);
  }

  if (alertCount >= 3) {
    recNum++;
    log(`\n${recNum}. ${alertCount} capacity alerts - prioritize hiring or extending hours.`);
  }

  if (adData && adData.overallCPB > 25) {
    recNum++;
    log(`\n${recNum}. Ad CPB at $${adData.overallCPB.toFixed(2)} - above $25 target. Review underperforming campaigns.`);
  }

  if (adData && adData.totalMetaSpend < 10) {
    recNum++;
    log(`\n${recNum}. Meta spend is near zero - is this intentional or an issue?`);
  }

  log("\n" + "=".repeat(70));
  log("Run: npx tsx scripts/daily-brief-v3.ts");
  log("=".repeat(70) + "\n");

  // Save to Obsidian
  try {
    const dateForFile = today.toISOString().split("T")[0];
    const obsidianFile = path.join(OBSIDIAN_DAILY_BRIEFING_PATH, `${dateForFile}.md`);

    if (!fs.existsSync(OBSIDIAN_DAILY_BRIEFING_PATH)) {
      fs.mkdirSync(OBSIDIAN_DAILY_BRIEFING_PATH, { recursive: true });
    }

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
    console.log(`Saved to Obsidian: ${obsidianFile}`);
  } catch (err: any) {
    console.error(`Could not save to Obsidian: ${err.message}`);
  }
}

generateBrief().catch(console.error);

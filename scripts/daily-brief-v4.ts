import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { BigQuery } from "@google-cloud/bigquery";
import { getAdPerformance, type PortfolioAdSummary } from "../lib/bigquery";
import { pushFileToGitHub } from "../lib/github";
import { sendProntoMessage } from "../lib/pronto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Google Cloud credentials bootstrap (for Railway / CI) ---
// When running outside GCP, provide the service account JSON as an env var.
// The BigQuery SDK reads GOOGLE_APPLICATION_CREDENTIALS (path to a file).
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const tmpPath = path.join(os.tmpdir(), "gcp-sa-key.json");
  fs.writeFileSync(tmpPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

// --- Output mode detection ---
const USE_GITHUB = !!(process.env.GITHUB_TOKEN && process.env.OBSIDIAN_REPO);
const OBSIDIAN_PATH = path.join(os.homedir(), "Obsidian Vaults/Austin's Brain/Hello Sugar/Daily Briefing");
const OBSIDIAN_REPO_PATH = "Austin's Brain/Hello Sugar/Daily Briefing"; // path inside the GitHub repo

// BigQuery client
const bigquery = new BigQuery({ projectId: "even-affinity-388602" });
const DATASET = "snowflake_data";

// BLVD client
const BLVD_API_URL = "https://dashboard.boulevard.io/api/2020-01/admin";

function generateAuthHeader(): string {
  const apiKey = process.env.BLVD_API_KEY!;
  const apiSecret = process.env.BLVD_API_SECRET!;
  const businessId = process.env.BLVD_BUSINESS_ID!;
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `blvd-admin-v1${businessId}${timestamp}`;
  const rawKey = Buffer.from(apiSecret, "base64");
  const signature = crypto.createHmac("sha256", rawKey).update(payload, "utf8").digest("base64");
  return `Basic ${Buffer.from(`${apiKey}:${signature}${payload}`, "utf8").toString("base64")}`;
}

const blvdClient = new GraphQLClient(BLVD_API_URL, {
  headers: { Authorization: generateAuthHeader() }
});

// Load config
const configPath = path.join(__dirname, "../config/utah-locations.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// BQ location name mapping
// OWNED LOCATIONS ONLY - Do not add franchises or acquisition targets
// See docs/DAILY-BRIEF-PLAN.md for the authoritative list
const LOCATION_NAME_MAP: Record<string, string> = {
  "Bountiful": "UT Bountiful | Colonial Square 042",
  "Farmington": "UT Farmington | Farmington Station 227",
  "Heber City": "UT Heber City | Valley Station 236",
  "Ogden": "UT Ogden | Riverdale 082",
  "Riverton": "UT Riverton | Mountain View Village 237",
  "Sugar House": "UT Salt Lake City | Sugar House 126",
  "West Valley": "UT West Valley | Valley Fair 176",
};

// SQL IN clause for owned locations - use this instead of LIKE 'UT %'
const OWNED_LOCATIONS_SQL = Object.values(LOCATION_NAME_MAP)
  .map(loc => `'${loc}'`)
  .join(", ");

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];


interface LocationData {
  shortName: string;
  bqName: string;
  blvdId: string;
  // Next 7 days (forecast)
  utilization: number;
  scheduledMinutes: number;
  bookedMinutes: number;
  blockedMinutes: number;
  // Past 7 days (actual)
  pastUtilization: number;
  pastBookedMinutes: number;
  // Trend
  utilizationTrend: number | null; // forecast vs actual difference
  upcomingAppts: number;
  staffCount: number;
  bookingsYesterday: number;
  bookings7DayAvg: number;
  newClientsYesterday: number;
  mtdAppts: number;
  lmAppts: number;
  apptsChange: number | null;
  mtdNew: number;
  lmNew: number;
  newChange: number | null;
  mtdReturning: number;
  // Revenue (Cash + Credit)
  mtdRevenue: number;
  lmRevenue: number;
  revenueChange: number | null;
  // Membership Renewals
  mtdRenewals: number;
  lmRenewals: number;
  // Cash
  cashCollectedYesterday: number;
  capacityAlerts: { staff: string; day: string; bucket: string; util: number }[];
  highUtilShifts: { staff: string; day: string; bucket: string; util: number }[];
  // Location-level MCR
  locationMcr: { newClients: number; memberships: number; mcr: number };
  // Staff-level MCR
  staffMcr: { name: string; newClients: number; memberships: number; mcr: number }[];
  topServices: { name: string; count: number }[];
}

// ═══════════════════════════════════════════════════════════════════════════
// BIGQUERY DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════

async function fetchBQData(targetDate: string) {
  // Use DATE 'YYYY-MM-DD' literal instead of ${TARGET_DATE} for backfilling
  const TARGET_DATE = `DATE '${targetDate}'`;
  const results = await Promise.all([
    // Booking velocity (yesterday vs 7-day avg)
    bigquery.query({
      query: `
        WITH daily AS (
          SELECT
            _COL_1 as location,
            _COL_0 as date,
            SUM(CAST(_COL_5 AS INT64)) as appts,
            SUM(CAST(_COL_8 AS INT64)) as new_clients
          FROM \`${DATASET}.tbl_mcr_data_agg\`
          WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
            AND _COL_0 >= DATE_SUB(${TARGET_DATE}, INTERVAL 8 DAY)
          GROUP BY 1, 2
        )
        SELECT
          location,
          SUM(CASE WHEN date = DATE_SUB(${TARGET_DATE}, INTERVAL 1 DAY) THEN appts ELSE 0 END) as yesterday_appts,
          SUM(CASE WHEN date = DATE_SUB(${TARGET_DATE}, INTERVAL 1 DAY) THEN new_clients ELSE 0 END) as yesterday_new,
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
          WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
            AND _COL_0 >= DATE_TRUNC(${TARGET_DATE}, MONTH)
          GROUP BY 1
        ),
        last_month AS (
          SELECT
            _COL_1 as location,
            SUM(CAST(_COL_5 AS INT64)) as total_appts,
            SUM(CAST(_COL_8 AS INT64)) as new_clients,
            SUM(CAST(_COL_11 AS INT64)) as returning_clients
          FROM \`${DATASET}.tbl_mcr_data_agg\`
          WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
            AND _COL_0 >= DATE_SUB(DATE_TRUNC(${TARGET_DATE}, MONTH), INTERVAL 1 MONTH)
            AND _COL_0 <= DATE_SUB(${TARGET_DATE}, INTERVAL 1 MONTH)
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
    // Staff MCR% MTD (per location - used for location-level aggregation)
    bigquery.query({
      query: `
        SELECT
          _COL_1 as location,
          _COL_3 as staff,
          SUM(CAST(_COL_8 AS INT64)) as new_clients,
          SUM(CAST(_COL_9 AS INT64)) as memberships,
          ROUND(SAFE_DIVIDE(SUM(CAST(_COL_9 AS INT64)), SUM(CAST(_COL_8 AS INT64))) * 100, 0) as mcr_pct
        FROM \`${DATASET}.tbl_mcr_data_agg\`
        WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
          AND _COL_0 >= DATE_TRUNC(${TARGET_DATE}, MONTH)
        GROUP BY 1, 2
        HAVING SUM(CAST(_COL_8 AS INT64)) > 0
      `
    }),
    // Staff MCR% MTD (combined across owned locations only)
    bigquery.query({
      query: `
        SELECT
          _COL_3 as staff,
          SUM(CAST(_COL_8 AS INT64)) as new_clients,
          SUM(CAST(_COL_9 AS INT64)) as memberships,
          ROUND(SAFE_DIVIDE(SUM(CAST(_COL_9 AS INT64)), SUM(CAST(_COL_8 AS INT64))) * 100, 0) as mcr_pct
        FROM \`${DATASET}.tbl_mcr_data_agg\`
        WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
          AND _COL_0 >= DATE_TRUNC(${TARGET_DATE}, MONTH)
        GROUP BY 1
        HAVING SUM(CAST(_COL_8 AS INT64)) > 0
      `
    }),
    // Revenue (Cash + Credit) MTD vs Last Month
    bigquery.query({
      query: `
        WITH combined AS (
          SELECT _COL_0 as dt, _COL_1 as location, CAST(_COL_2 AS FLOAT64) as amount
          FROM \`${DATASET}.tbl_location_daily_payments_refunds_curr\`
          WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
          UNION ALL
          SELECT _COL_0 as dt, _COL_1 as location, CAST(_COL_2 AS FLOAT64) as amount
          FROM \`${DATASET}.tbl_location_daily_payments_refunds\`
          WHERE _COL_1 IN (${OWNED_LOCATIONS_SQL})
        ),
        this_month AS (
          SELECT location, SUM(amount) as mtd_revenue
          FROM combined
          WHERE dt >= DATE_TRUNC(${TARGET_DATE}, MONTH)
            AND dt <= ${TARGET_DATE}
          GROUP BY 1
        ),
        last_month AS (
          SELECT location, SUM(amount) as lm_revenue
          FROM combined
          WHERE dt >= DATE_SUB(DATE_TRUNC(${TARGET_DATE}, MONTH), INTERVAL 1 MONTH)
            AND dt <= DATE_SUB(${TARGET_DATE}, INTERVAL 1 MONTH)
          GROUP BY 1
        )
        SELECT
          t.location,
          ROUND(t.mtd_revenue, 0) as mtd_revenue,
          ROUND(l.lm_revenue, 0) as lm_revenue,
          ROUND((t.mtd_revenue - l.lm_revenue) / NULLIF(l.lm_revenue, 0) * 100, 0) as revenue_chg
        FROM this_month t
        LEFT JOIN last_month l ON t.location = l.location
      `
    }),
    // Membership Renewals MTD vs Last Month
    bigquery.query({
      query: `
        WITH this_month AS (
          SELECT _COL_13 as location, COUNT(*) as renewals
          FROM \`${DATASET}.tbl_combined_membership_events\`
          WHERE _COL_13 IN (${OWNED_LOCATIONS_SQL})
            AND _COL_4 = 'RENEWAL_SUCCEEDED'
            AND _COL_1 >= DATE_TRUNC(${TARGET_DATE}, MONTH)
            AND _COL_1 <= ${TARGET_DATE}
          GROUP BY 1
        ),
        last_month AS (
          SELECT _COL_13 as location, COUNT(*) as renewals
          FROM \`${DATASET}.tbl_combined_membership_events\`
          WHERE _COL_13 IN (${OWNED_LOCATIONS_SQL})
            AND _COL_4 = 'RENEWAL_SUCCEEDED'
            AND _COL_1 >= DATE_SUB(DATE_TRUNC(${TARGET_DATE}, MONTH), INTERVAL 1 MONTH)
            AND _COL_1 <= DATE_SUB(${TARGET_DATE}, INTERVAL 1 MONTH)
          GROUP BY 1
        )
        SELECT
          t.location,
          t.renewals as mtd_renewals,
          l.renewals as lm_renewals
        FROM this_month t
        LEFT JOIN last_month l ON t.location = l.location
      `
    }),
    // Reviews (past 7 days, sub-5-star only, owned locations only)
    bigquery.query({
      query: `
        SELECT
          _COL_1 as location,
          _COL_3 as review_date,
          CAST(_COL_7 AS INT64) as stars,
          _COL_11 as reviewer,
          _COL_13 as review_text
        FROM \`${DATASET}.tbl_review_account_location_view\`
        WHERE _COL_1 IN (
          'UT Bountiful | Colonial Square 042',
          'UT Farmington | Farmington Station 227',
          'UT Heber City | Valley Station 236',
          'UT Ogden | Riverdale 082',
          'UT Riverton | Mountain View Village 237',
          'UT Salt Lake City | Sugar House 126',
          'UT West Valley | Valley Fair 176'
        )
          AND _COL_3 >= DATE_SUB(${TARGET_DATE}, INTERVAL 7 DAY)
          AND CAST(_COL_7 AS INT64) < 5
        ORDER BY _COL_3 DESC
      `
    }),
    // Upcoming appointments (next 7 days)
    bigquery.query({
      query: `
        SELECT
          _COL_4 as location,
          _COL_9 as staff,
          _COL_0 as appt_date,
          EXTRACT(HOUR FROM TIMESTAMP(_COL_7)) as start_hour,
          CAST(_COL_2 AS INT64) as duration_min
        FROM \`${DATASET}.tbl_booked_detailed\`
        WHERE _COL_4 IN (${OWNED_LOCATIONS_SQL})
          AND _COL_0 >= ${TARGET_DATE}
          AND _COL_0 < DATE_ADD(${TARGET_DATE}, INTERVAL 7 DAY)
      `
    }),
    // Past 7 days completed appointments (for actual utilization)
    // Using 30 min avg duration estimate since raw table lacks duration column
    bigquery.query({
      query: `
        SELECT
          _COL_17 as location,
          _COL_28 as appt_date,
          EXTRACT(HOUR FROM TIMESTAMP(_COL_27)) as start_hour,
          30 as duration_min
        FROM \`${DATASET}.tbl_adhoc_all_completed_bookings\`
        WHERE _COL_17 IN (${OWNED_LOCATIONS_SQL})
          AND _COL_28 >= DATE_SUB(${TARGET_DATE}, INTERVAL 7 DAY)
          AND _COL_28 < ${TARGET_DATE}
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
        WHERE _COL_17 IN (${OWNED_LOCATIONS_SQL})
          AND _COL_28 >= DATE_SUB(${TARGET_DATE}, INTERVAL 14 DAY)
        GROUP BY 1, 2
        ORDER BY 1, 3 DESC
      `
    }),
    // Yesterday's lost clients (true churn only)
    bigquery.query({
      query: `
        WITH active_clients AS (
          SELECT DISTINCT CLIENT_ID FROM \`${DATASET}.tbl_memberships_report_partitioned\` WHERE STATUS = 'ACTIVE'
        )
        SELECT
          c._COL_10 as client_id,
          c._COL_14 as location,
          c._COL_11 as client,
          c._COL_12 as email,
          c._COL_8 as membership,
          CAST(c._COL_4 AS INT64) as months,
          c._COL_28 as reason,
          c._COL_32 as feedback
        FROM \`${DATASET}.tbl_non_active_membership_with_response\` c
        LEFT JOIN active_clients ac ON c._COL_10 = ac.CLIENT_ID
        WHERE c._COL_14 IN (${OWNED_LOCATIONS_SQL})
          AND c._COL_5 = 'CANCELLED'
          AND c._COL_0 = DATE_SUB(${TARGET_DATE}, INTERVAL 1 DAY)
          AND ac.CLIENT_ID IS NULL
        ORDER BY c._COL_14
      `
    }),
    // Early churn by esthetician (MTD, ≤2 months)
    bigquery.query({
      query: `
        WITH active_clients AS (
          SELECT DISTINCT CLIENT_ID FROM \`${DATASET}.tbl_memberships_report_partitioned\` WHERE STATUS = 'ACTIVE'
        )
        SELECT
          c._COL_24 as esthetician,
          c._COL_14 as location,
          COUNT(*) as early_churns,
          ROUND(AVG(CAST(c._COL_4 AS INT64)), 1) as avg_months
        FROM \`${DATASET}.tbl_non_active_membership_with_response\` c
        LEFT JOIN active_clients ac ON c._COL_10 = ac.CLIENT_ID
        WHERE c._COL_14 IN (${OWNED_LOCATIONS_SQL})
          AND c._COL_5 = 'CANCELLED'
          AND CAST(c._COL_4 AS INT64) <= 2
          AND c._COL_0 >= DATE_TRUNC(${TARGET_DATE}, MONTH)
          AND ac.CLIENT_ID IS NULL
        GROUP BY 1, 2
        HAVING COUNT(*) > 0
        ORDER BY 3 DESC
      `
    }),
    // Missed Expectations (last 30 days)
    bigquery.query({
      query: `
        WITH active_clients AS (
          SELECT DISTINCT CLIENT_ID FROM \`${DATASET}.tbl_memberships_report_partitioned\` WHERE STATUS = 'ACTIVE'
        )
        SELECT
          c._COL_10 as client_id,
          c._COL_0 as date,
          c._COL_14 as location,
          c._COL_11 as client,
          c._COL_24 as last_staff,
          CAST(c._COL_4 AS INT64) as months,
          c._COL_32 as feedback
        FROM \`${DATASET}.tbl_non_active_membership_with_response\` c
        LEFT JOIN active_clients ac ON c._COL_10 = ac.CLIENT_ID
        WHERE c._COL_14 IN (${OWNED_LOCATIONS_SQL})
          AND c._COL_5 = 'CANCELLED'
          AND c._COL_28 = 'Missed Expectations'
          AND c._COL_0 >= DATE_SUB(${TARGET_DATE}, INTERVAL 30 DAY)
          AND ac.CLIENT_ID IS NULL
        ORDER BY c._COL_0 DESC
      `
    }),
    // Long-tenure losses (6+ months, last 30 days) - excludes clients with future appointments
    bigquery.query({
      query: `
        WITH active_clients AS (
          SELECT DISTINCT CLIENT_ID FROM \`${DATASET}.tbl_memberships_report_partitioned\` WHERE STATUS = 'ACTIVE'
        ),
        clients_with_future_appts AS (
          SELECT DISTINCT CLIENT_ID
          FROM \`${DATASET}.tbl_adhoc_all_bookings_partitioned\`
          WHERE APPT_SCHED_DATE_CLEANED >= ${TARGET_DATE}
            AND CANCELLED_DATE IS NULL
        ),
        client_ltv AS (
          SELECT
            _COL_1 as client_id,
            ROUND(SUM(CAST(_COL_3 AS FLOAT64)), 0) as total_ltv
          FROM \`${DATASET}.tbl_orders_raw\`
          WHERE _COL_1 IS NOT NULL
          GROUP BY 1
        ),
        ranked_churns AS (
          SELECT
            c._COL_10 as client_id,
            c._COL_0 as date,
            c._COL_14 as location,
            c._COL_11 as client,
            c._COL_12 as email,
            c._COL_8 as membership,
            CAST(c._COL_4 AS INT64) as months,
            c._COL_28 as reason,
            c._COL_32 as feedback,
            COALESCE(cl.total_ltv, 0) as ltv,
            ROW_NUMBER() OVER (PARTITION BY c._COL_10 ORDER BY CAST(c._COL_4 AS INT64) DESC) as rn
          FROM \`${DATASET}.tbl_non_active_membership_with_response\` c
          LEFT JOIN active_clients ac ON c._COL_10 = ac.CLIENT_ID
          LEFT JOIN clients_with_future_appts fa ON c._COL_10 = fa.CLIENT_ID
          LEFT JOIN client_ltv cl ON c._COL_10 = cl.client_id
          WHERE c._COL_14 IN (${OWNED_LOCATIONS_SQL})
            AND c._COL_5 = 'CANCELLED'
            AND CAST(c._COL_4 AS INT64) >= 6
            AND c._COL_0 >= DATE_SUB(${TARGET_DATE}, INTERVAL 30 DAY)
            AND ac.CLIENT_ID IS NULL
            AND fa.CLIENT_ID IS NULL
        )
        SELECT client_id, date, location, client, email, membership, months, reason, feedback, ltv
        FROM ranked_churns
        WHERE rn = 1
        ORDER BY ltv DESC
      `
    }),
  ]);

  return {
    bookingVelocity: results[0][0],
    momComparison: results[1][0],
    staffMcr: results[2][0],
    combinedStaffMcr: results[3][0],
    revenueData: results[4][0],
    renewalsData: results[5][0],
    reviews: results[6][0],
    upcomingAppts: results[7][0],
    pastAppts: results[8][0],
    topServices: results[9][0],
    yesterdayChurn: results[10][0],
    earlyChurnByStaff: results[11][0],
    missedExpectations: results[12][0],
    longTernureLosses: results[13][0],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLVD DATA FETCHING (shifts + blocks)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchShiftsForLocation(locationId: string, startDate: string, endDate: string) {
  const query = gql`
    query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
      shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
        shifts { staffId day clockIn clockOut available recurrenceStart recurrenceEnd }
      }
    }
  `;
  try {
    const result = await blvdClient.request<any>(query, { locationId, startIso8601: startDate, endIso8601: endDate });
    return result.shifts.shifts || [];
  } catch { return []; }
}

// Timeblocks query (paginated)
const TIMEBLOCKS_QUERY = gql`
  query GetTimeblocks($locationId: ID!, $first: Int, $after: String) {
    timeblocks(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id startAt endAt duration title cancelled
          staff { id }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface Timeblock {
  id: string;
  startAt: string;
  endAt: string;
  duration: number;
  title?: string;
  cancelled?: boolean;
  staff?: { id: string };
}

function isBTBBlock(tb: Timeblock): boolean {
  const title = tb.title?.toLowerCase() ?? "";
  return title.includes("btb") || title.includes("b2b") || title.includes("back to back");
}

async function fetchBlocksForLocation(locationId: string, startDate: string, endDate: string): Promise<Timeblock[]> {
  const allBlocks: Timeblock[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  const startTime = new Date(startDate + "T00:00:00-06:00").getTime();
  const endTime = new Date(endDate + "T23:59:59-06:00").getTime();

  while (hasNextPage) {
    try {
      const data = await blvdClient.request<any>(TIMEBLOCKS_QUERY, {
        locationId,
        first: 100,
        after: cursor
      });

      for (const edge of data.timeblocks.edges) {
        const tb = edge.node;
        if (tb.cancelled) continue;

        // Filter by date range
        const tbStart = new Date(tb.startAt).getTime();
        if (tbStart >= startTime && tbStart <= endTime) {
          allBlocks.push(tb);
        }
      }

      hasNextPage = data.timeblocks.pageInfo.hasNextPage;
      cursor = data.timeblocks.pageInfo.endCursor;

      // Rate limit protection
      if (hasNextPage) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch {
      break;
    }
  }

  return allBlocks;
}

// ═══════════════════════════════════════════════════════════════════════════
// CASH COLLECTION
// ═══════════════════════════════════════════════════════════════════════════

const ORDERS_QUERY = gql`
  query GetOrders($locationId: ID!, $first: Int!, $after: String) {
    orders(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          closedAt
          paymentGroups {
            payments {
              ... on OrderCashPayment {
                paidAmount
                refundAmount
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchDailyCash(locationId: string, targetDate: string): Promise<number> {
  let cursor: string | null = null;
  let totalCash = 0;
  let pages = 0;
  const maxPages = 20; // Safety limit

  while (pages < maxPages) {
    try {
      const data = await blvdClient.request<any>(ORDERS_QUERY, {
        locationId,
        first: 50,
        after: cursor
      });
      pages++;

      let foundOlder = false;
      for (const edge of data.orders.edges) {
        const order = edge.node;
        if (!order.closedAt) continue;

        const orderDate = order.closedAt.split("T")[0];

        // If order is from before target date, stop searching
        if (orderDate < targetDate) {
          foundOlder = true;
          break;
        }

        // If order is from target date, count cash
        if (orderDate === targetDate) {
          for (const pg of order.paymentGroups || []) {
            for (const payment of pg.payments || []) {
              if (payment.paidAmount !== undefined) {
                totalCash += payment.paidAmount - (payment.refundAmount || 0);
              }
            }
          }
        }
      }

      if (foundOlder || !data.orders.pageInfo.hasNextPage) break;
      cursor = data.orders.pageInfo.endCursor;

      // Rate limit protection
      await new Promise(r => setTimeout(r, 100));
    } catch {
      break;
    }
  }

  return totalCash; // Returns cents
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIZATION CALCULATION (with blocks)
// ═══════════════════════════════════════════════════════════════════════════

function calculateUtilization(
  shifts: any[],
  blocks: Timeblock[],
  upcomingAppts: any[],
  locationBqName: string,
  periodStart: Date,
  periodEnd: Date
) {
  const AM_START = 8, AM_END = 14, PM_START = 14, PM_END = 20;

  // Build scheduled minutes by staff/day/bucket
  const bucketData = new Map<string, { staff: string; day: number; bucket: string; scheduledMin: number; bookedMin: number; blockedMin: number }>();

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
                bucketData.set(key, { staff: shift.staffId, day: shift.day, bucket, scheduledMin: 0, bookedMin: 0, blockedMin: 0 });
              }
              bucketData.get(key)!.scheduledMin += scheduledMin;
            }
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Subtract blocked time (lunch, DNB) but NOT BTB blocks
  // BTB blocks represent unfilled capacity, not unavailable time
  for (const block of blocks) {
    if (isBTBBlock(block)) continue; // Skip BTB - keep as bookable

    const blockStart = new Date(block.startAt);
    const blockEnd = new Date(block.endAt);
    if (blockStart > periodEnd || blockEnd < periodStart) continue;

    const dayOfWeek = blockStart.getDay();
    const startHour = blockStart.getHours() + blockStart.getMinutes() / 60;
    const durationMin = block.duration || 0;
    const bucket = startHour < 14 ? "AM" : "PM";

    // Apply to matching staff bucket
    // Normalize staff ID (block uses urn:blvd:Staff:xxx, shifts use just xxx)
    const rawStaffId = block.staff?.id;
    if (rawStaffId) {
      const staffId = rawStaffId.replace("urn:blvd:Staff:", "");
      const key = `${staffId}|${dayOfWeek}|${bucket}`;
      if (bucketData.has(key)) {
        bucketData.get(key)!.blockedMin += durationMin;
      }
    }
  }

  // Aggregate scheduled/blocked by day/bucket (across all staff)
  const locationBuckets = new Map<string, { day: number; bucket: string; scheduledMin: number; bookedMin: number; blockedMin: number }>();

  for (const [_, data] of bucketData) {
    const key = `${data.day}|${data.bucket}`;
    if (!locationBuckets.has(key)) {
      locationBuckets.set(key, { day: data.day, bucket: data.bucket, scheduledMin: 0, bookedMin: 0, blockedMin: 0 });
    }
    const lb = locationBuckets.get(key)!;
    lb.scheduledMin += data.scheduledMin;
    lb.blockedMin += data.blockedMin;
  }

  // Add booked minutes from BQ data (aggregated by day/bucket)
  const locationAppts = upcomingAppts.filter((a: any) => a.location === locationBqName);

  for (const appt of locationAppts) {
    const dateStr = appt.appt_date?.value || appt.appt_date;
    const apptDate = new Date(dateStr + "T12:00:00");
    if (apptDate < periodStart || apptDate > periodEnd) continue;

    const dayOfWeek = apptDate.getDay();
    const hour = Number(appt.start_hour);
    const bucket = hour < 14 ? "AM" : "PM";
    const duration = Number(appt.duration_min) || 0;

    const key = `${dayOfWeek}|${bucket}`;
    if (locationBuckets.has(key)) {
      locationBuckets.get(key)!.bookedMin += duration;
    }
  }

  // Calculate results
  let totalScheduled = 0, totalBooked = 0, totalBlocked = 0;
  const shiftUtils: { staff: string; day: string; bucket: string; util: number }[] = [];

  for (const [_, data] of locationBuckets) {
    const availableMin = Math.max(0, data.scheduledMin - data.blockedMin);
    const util = availableMin > 0 ? (data.bookedMin / availableMin) * 100 : 0;
    totalScheduled += data.scheduledMin;
    totalBooked += data.bookedMin;
    totalBlocked += data.blockedMin;

    if (availableMin > 60) {
      shiftUtils.push({
        staff: "", // Location-level, not staff-specific
        day: dayNames[data.day],
        bucket: data.bucket === "AM" ? "8AM-2PM" : "2PM-8PM",
        util: Math.round(util)
      });
    }
  }

  const availableTotal = Math.max(0, totalScheduled - totalBlocked);
  const utilization = availableTotal > 0 ? Math.round((totalBooked / availableTotal) * 100) : 0;

  return {
    utilization,
    scheduledMinutes: totalScheduled,
    bookedMinutes: totalBooked,
    blockedMinutes: totalBlocked,
    highUtilShifts: shiftUtils.filter(s => s.util >= 50 && s.util < 75).sort((a, b) => b.util - a.util).slice(0, 5),
    capacityAlerts: shiftUtils.filter(s => s.util >= 75).sort((a, b) => b.util - a.util).slice(0, 5),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKDOWN FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════

function formatPercent(value: number | null, showSign = true): string {
  if (value === null || value === undefined) return "—";
  const sign = showSign && value > 0 ? "+" : "";
  return `${sign}${Math.round(value)}%`;
}

function getStatusEmoji(value: number, thresholds: [number, number] = [25, 50]): string {
  if (value >= thresholds[1]) return "🟢";
  if (value >= thresholds[0]) return "🟡";
  return "🔴";
}

function getVelocityEmoji(delta: number): string {
  if (delta >= 10) return "🚀";
  if (delta >= -10) return "➡️";
  return "⚠️";
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN BRIEF GENERATION
// ═══════════════════════════════════════════════════════════════════════════

async function generateBrief(targetDateStr?: string) {
  // Accept optional date argument (YYYY-MM-DD format) for backfilling
  const today = targetDateStr ? new Date(targetDateStr + "T12:00:00-06:00") : new Date();
  const todayStr = today.toISOString().split("T")[0];

  // Date ranges: past 7 days and next 7 days
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];
  const sevenDaysOut = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const sevenDaysOutStr = sevenDaysOut.toISOString().split("T")[0];

  const dayOfMonth = today.getDate();
  const dayName = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // Date range formatting helper
  const formatShortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Formatted date ranges for section headers
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = formatShortDate(yesterday);
  const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const dateRanges = {
    yesterday: yesterdayStr,
    last7Days: `${formatShortDate(sevenDaysAgo)} - ${formatShortDate(yesterday)}`,
    next7Days: `${formatShortDate(today)} - ${formatShortDate(new Date(today.getTime() + 6 * 24 * 60 * 60 * 1000))}`,
    mtd: `${formatShortDate(monthStart)} - ${formatShortDate(today)}`,
    last2Weeks: `${formatShortDate(twoWeeksAgo)} - ${formatShortDate(today)}`,
  };

  console.log(`\n📊 Generating Daily Brief for ${dayName}...\n`);

  // Fetch all data in parallel
  console.log("Fetching BigQuery data...");
  const bqData = await fetchBQData(todayStr);
  console.log(`  ✓ ${bqData.upcomingAppts.length} upcoming, ${bqData.pastAppts.length} past appointments`);

  console.log("Fetching Boulevard shifts & blocks...");
  // Future period (next 7 days)
  const futureStart = new Date(todayStr + "T00:00:00-06:00");
  const futureEnd = new Date(sevenDaysOutStr + "T23:59:59-06:00");
  // Past period (last 7 days)
  const pastStart = new Date(sevenDaysAgoStr + "T00:00:00-06:00");
  const pastEnd = new Date(todayStr + "T00:00:00-06:00");

  const blvdPromises = config.owned.map((loc: any) =>
    Promise.all([
      fetchShiftsForLocation(loc.id, sevenDaysAgoStr, sevenDaysOutStr), // Full 14-day range for shifts
      fetchBlocksForLocation(loc.id, sevenDaysAgoStr, sevenDaysOutStr), // Full 14-day range for blocks
      fetchDailyCash(loc.id, yesterdayStr) // Yesterday's cash
    ]).then(([shifts, blocks, cashCents]) => ({
      shortName: loc.shortName,
      blvdId: loc.id,
      shifts,
      blocks,
      cashCents
    }))
  );
  const allBlvdData = await Promise.all(blvdPromises);
  const totalShifts = allBlvdData.reduce((sum, l) => sum + l.shifts.length, 0);
  const totalBlocks = allBlvdData.reduce((sum, l) => sum + l.blocks.length, 0);
  const totalCash = allBlvdData.reduce((sum, l) => sum + l.cashCents, 0);
  console.log(`  ✓ ${totalShifts} shifts, ${totalBlocks} blocks, $${(totalCash / 100).toFixed(0)} cash yesterday`);

  // Fetch ad data
  console.log("Fetching advertising data...");
  const shortNames = config.owned.map((l: any) => l.shortName);
  let adData: PortfolioAdSummary | null = null;
  try {
    adData = await getAdPerformance(shortNames, 7);
    console.log(`  ✓ $${adData.totalSpend.toFixed(0)} total spend`);
  } catch (err) {
    console.log("  ⚠ Could not fetch ad data");
  }

  // Build location data
  const locationData: LocationData[] = [];

  for (const locData of allBlvdData) {
    const bqName = LOCATION_NAME_MAP[locData.shortName];
    if (!bqName) continue;

    // Future utilization (next 7 days - forecast)
    const futureUtilData = calculateUtilization(
      locData.shifts,
      locData.blocks,
      bqData.upcomingAppts,
      bqName,
      futureStart,
      futureEnd
    );

    // Past utilization (last 7 days - actual)
    const pastUtilData = calculateUtilization(
      locData.shifts,
      locData.blocks,
      bqData.pastAppts,
      bqName,
      pastStart,
      pastEnd
    );

    const velocity = bqData.bookingVelocity.find((v: any) => v.location === bqName) || {};
    const mom = bqData.momComparison.find((m: any) => m.location === bqName) || {};
    const revenue = bqData.revenueData.find((r: any) => r.location === bqName) || {};
    const renewals = bqData.renewalsData.find((r: any) => r.location === bqName) || {};
    const staffMcr = bqData.staffMcr
      .filter((s: any) => s.location === bqName)
      .map((s: any) => ({
        name: s.staff,
        newClients: Number(s.new_clients),
        memberships: Number(s.memberships),
        mcr: Number(s.mcr_pct) || 0
      }))
      .sort((a: any, b: any) => b.mcr - a.mcr);

    // Calculate location-level MCR by summing staff totals
    const locationNewClients = staffMcr.reduce((sum, s) => sum + s.newClients, 0);
    const locationMemberships = staffMcr.reduce((sum, s) => sum + s.memberships, 0);
    const locationMcr = {
      newClients: locationNewClients,
      memberships: locationMemberships,
      mcr: locationNewClients > 0 ? Math.round((locationMemberships / locationNewClients) * 100) : 0
    };

    const topServices = bqData.topServices
      .filter((s: any) => s.location === bqName)
      .slice(0, 5)
      .map((s: any) => ({ name: s.services, count: Number(s.count) }));
    const upcomingAppts = bqData.upcomingAppts.filter((a: any) => a.location === bqName).length;
    const staffCount = new Set(bqData.upcomingAppts.filter((a: any) => a.location === bqName).map((a: any) => a.staff)).size;

    // Calculate trend (forecast vs actual)
    const utilizationTrend = pastUtilData.utilization > 0
      ? futureUtilData.utilization - pastUtilData.utilization
      : null;

    locationData.push({
      shortName: locData.shortName,
      bqName,
      blvdId: locData.blvdId,
      utilization: futureUtilData.utilization,
      scheduledMinutes: futureUtilData.scheduledMinutes,
      bookedMinutes: futureUtilData.bookedMinutes,
      blockedMinutes: futureUtilData.blockedMinutes,
      pastUtilization: pastUtilData.utilization,
      pastBookedMinutes: pastUtilData.bookedMinutes,
      utilizationTrend,
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
      mtdRevenue: Number(revenue.mtd_revenue) || 0,
      lmRevenue: Number(revenue.lm_revenue) || 0,
      revenueChange: revenue.revenue_chg != null ? Number(revenue.revenue_chg) : null,
      mtdRenewals: Number(renewals.mtd_renewals) || 0,
      lmRenewals: Number(renewals.lm_renewals) || 0,
      cashCollectedYesterday: locData.cashCents / 100, // Convert cents to dollars
      capacityAlerts: futureUtilData.capacityAlerts,
      highUtilShifts: futureUtilData.highUtilShifts,
      locationMcr,
      staffMcr,
      topServices,
    });
  }

  locationData.sort((a, b) => b.utilization - a.utilization);

  // Calculate aggregates
  const portfolioYesterday = locationData.reduce((sum, l) => sum + l.bookingsYesterday, 0);
  const portfolioAvg = locationData.reduce((sum, l) => sum + l.bookings7DayAvg, 0);
  const velocityDelta = portfolioAvg > 0 ? Math.round(((portfolioYesterday - portfolioAvg) / portfolioAvg) * 100) : 0;
  const newClientsYesterday = locationData.reduce((sum, l) => sum + l.newClientsYesterday, 0);
  const alertCount = locationData.reduce((sum, l) => sum + l.capacityAlerts.length, 0);
  const avgPastUtil = Math.round(locationData.reduce((sum, l) => sum + l.pastUtilization, 0) / locationData.length);
  const avgFutureUtil = Math.round(locationData.reduce((sum, l) => sum + l.utilization, 0) / locationData.length);
  const avgUtilTrend = avgFutureUtil - avgPastUtil;
  const best = locationData[0];
  const worst = locationData[locationData.length - 1];

  // ═══════════════════════════════════════════════════════════════════════
  // BUILD MARKDOWN OUTPUT
  // ═══════════════════════════════════════════════════════════════════════

  const md: string[] = [];

  // Frontmatter
  md.push(`---`);
  md.push(`date: ${todayStr}`);
  md.push(`type: daily-briefing`);
  md.push(`tags: [hello-sugar, operations, utah]`);
  md.push(`---`);
  md.push(``);

  // Header
  md.push(`# Hello Sugar Utah - Daily Brief`);
  md.push(`**${dayName}**`);
  md.push(``);

  // ═══════════════════════════════════════════════════════════════════════
  // RECOMMENDATIONS (moved to top)
  // ═══════════════════════════════════════════════════════════════════════
  md.push(`## 🎯 Action Items`);
  md.push(``);

  const recommendations: string[] = [];

  if (velocityDelta < -20) {
    recommendations.push(`**Booking velocity down ${Math.abs(velocityDelta)}%** yesterday vs 7-day avg - consider flash promo or check marketing`);
  } else if (velocityDelta > 30) {
    recommendations.push(`**Booking velocity up ${velocityDelta}%** - momentum strong, push marketing harder`);
  }

  if (alertCount >= 1) {
    recommendations.push(`**${alertCount} capacity alert${alertCount > 1 ? 's'  : ''}** - prioritize adding coverage or opening waitlist`);
  }

  if (best.utilization > 0 && worst.utilization < best.utilization - 10) {
    recommendations.push(`**${worst.shortName} at ${worst.utilization}%** vs ${best.shortName} at ${best.utilization}% - investigate gap`);
  }

  if (adData && adData.overallCPB > 25) {
    recommendations.push(`**Ad CPB at $${adData.overallCPB.toFixed(2)}** - above $25 target, review campaigns`);
  }

  if (adData && adData.alerts.length > 0) {
    for (const alert of adData.alerts.slice(0, 2)) {
      recommendations.push(`⚠️ ${alert}`);
    }
  }

  if (recommendations.length === 0) {
    md.push(`✅ No urgent actions needed today.`);
  } else {
    for (const rec of recommendations) {
      md.push(`- ${rec}`);
    }
  }
  md.push(``);

  // ═══════════════════════════════════════════════════════════════════════
  // PORTFOLIO SNAPSHOT
  // ═══════════════════════════════════════════════════════════════════════
  md.push(`## 📈 Portfolio Snapshot`);
  md.push(``);
  const utilTrendEmoji = avgUtilTrend > 0 ? "📈" : avgUtilTrend < 0 ? "📉" : "➡️";
  md.push(`| Metric | Value |`);
  md.push(`|--------|-------|`);
  md.push(`| Yesterday Bookings | ${portfolioYesterday} (${formatPercent(velocityDelta)} vs avg) |`);
  md.push(`| New Clients Yesterday | ${newClientsYesterday} |`);
  md.push(`| Utilization (Last 7d) | ${avgPastUtil}% actual |`);
  md.push(`| Utilization (Next 7d) | ${avgFutureUtil}% forecast ${utilTrendEmoji} |`);
  if (adData) {
    md.push(`| Weekly Ad Spend | $${adData.totalSpend.toFixed(0)} |`);
    md.push(`| Cost per Booking | $${adData.overallCPB.toFixed(2)} |`);
  }
  md.push(``);

  // ═══════════════════════════════════════════════════════════════════════
  // CAPACITY ALERTS
  // ═══════════════════════════════════════════════════════════════════════
  const allAlerts = locationData.flatMap(l => l.capacityAlerts.map(a => ({ ...a, location: l.shortName })));

  if (allAlerts.length > 0) {
    md.push(`## 🚨 Capacity Alerts (≥75% Booked)`);
    md.push(`*${dateRanges.next7Days} — Shifts approaching full, add coverage or open waitlist*`);
    md.push(``);
    md.push(`| Location | Day | Time | Utilization |`);
    md.push(`|----------|-----|------|-------------|`);
    for (const alert of allAlerts.slice(0, 8)) {
      md.push(`| ${alert.location} | ${alert.day} | ${alert.bucket} | **${alert.util}%** |`);
    }
    md.push(``);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BOOKING VELOCITY
  // ═══════════════════════════════════════════════════════════════════════
  md.push(`## 📅 Booking Velocity`);
  md.push(`*${dateRanges.yesterday} vs 7-day avg (${dateRanges.last7Days})*`);
  md.push(``);
  md.push(`| Location | Yesterday | vs Avg | New Clients |`);
  md.push(`|----------|-----------|--------|-------------|`);

  const sortedByBookings = [...locationData].sort((a, b) => b.bookingsYesterday - a.bookingsYesterday);
  for (const loc of sortedByBookings) {
    const delta = loc.bookings7DayAvg > 0 ? Math.round(((loc.bookingsYesterday - loc.bookings7DayAvg) / loc.bookings7DayAvg) * 100) : 0;
    const emoji = getVelocityEmoji(delta);
    md.push(`| ${emoji} ${loc.shortName} | ${loc.bookingsYesterday} | ${formatPercent(delta)} | ${loc.newClientsYesterday} |`);
  }
  md.push(``);

  // ═══════════════════════════════════════════════════════════════════════
  // MONTH OVER MONTH
  // ═══════════════════════════════════════════════════════════════════════
  md.push(`## 📊 Month-over-Month`);
  md.push(`*${dateRanges.mtd} vs same period last month*`);
  md.push(``);
  md.push(`| Location | Revenue | Appts | New Clients | Renewals |`);
  md.push(`|----------|---------|-------|-------------|----------|`);

  const sortedByMtd = [...locationData].sort((a, b) => b.mtdRevenue - a.mtdRevenue);
  for (const loc of sortedByMtd) {
    if (loc.mtdAppts === 0 && loc.lmAppts === 0 && loc.mtdRevenue === 0) continue;
    const mtdRev = loc.mtdRevenue > 0 ? `$${(loc.mtdRevenue / 1000).toFixed(1)}k` : "—";
    const lmRev = loc.lmRevenue > 0 ? `$${(loc.lmRevenue / 1000).toFixed(1)}k` : "—";
    const revIcon = loc.mtdRevenue >= loc.lmRevenue ? "🟢" : "🔴";
    const apptsIcon = loc.mtdAppts >= loc.lmAppts ? "🟢" : "🔴";
    const newIcon = loc.mtdNew >= loc.lmNew ? "🟢" : "🔴";
    const renewIcon = loc.mtdRenewals >= loc.lmRenewals ? "🟢" : "🔴";
    md.push(`| ${loc.shortName} | ${revIcon} ${mtdRev}/${lmRev} | ${apptsIcon} ${loc.mtdAppts}/${loc.lmAppts} | ${newIcon} ${loc.mtdNew}/${loc.lmNew} | ${renewIcon} ${loc.mtdRenewals}/${loc.lmRenewals} |`);
  }
  md.push(``);

  // ═══════════════════════════════════════════════════════════════════════
  // SUB-5-STAR REVIEWS (Past 7 Days)
  // ═══════════════════════════════════════════════════════════════════════
  const reviews = bqData.reviews || [];
  if (reviews.length > 0) {
    md.push(`## ⚠️ Reviews Requiring Attention`);
    md.push(`*${dateRanges.last7Days} — Sub-5-star reviews*`);
    md.push(``);

    for (const review of reviews) {
      const stars = "⭐".repeat(Number(review.stars));
      const dateStr = review.review_date?.value || review.review_date;
      const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === review.location)?.[0] || review.location;
      md.push(`### ${stars} ${shortLoc} — ${dateStr}`);
      md.push(`**${review.reviewer}**`);
      md.push(``);
      md.push(`> ${review.review_text?.replace(/\n/g, "\n> ")}`);
      md.push(``);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILIZATION COMPARISON (Past 7 Days vs Next 7 Days)
  // ═══════════════════════════════════════════════════════════════════════
  md.push(`## 🏆 Utilization Comparison`);
  md.push(`*Last 7d (${dateRanges.last7Days}) vs Next 7d (${dateRanges.next7Days}) — Booked ÷ (scheduled - lunch/DNB)*`);
  md.push(``);
  md.push(`| Location | Last 7d | Next 7d | Trend | Prediction |`);
  md.push(`|----------|---------|---------|-------|------------|`);

  for (const loc of locationData) {
    const trendEmoji = loc.utilizationTrend === null ? "—" :
      loc.utilizationTrend > 5 ? "📈" :
      loc.utilizationTrend < -5 ? "📉" : "➡️";
    const trendText = loc.utilizationTrend !== null ? `${loc.utilizationTrend > 0 ? "+" : ""}${loc.utilizationTrend}%` : "—";

    // Prediction based on trend
    let prediction = "";
    if (loc.utilizationTrend !== null) {
      if (loc.utilizationTrend > 10) prediction = "Busy week ahead";
      else if (loc.utilizationTrend > 0) prediction = "Slight uptick";
      else if (loc.utilizationTrend < -10) prediction = "Slower week expected";
      else if (loc.utilizationTrend < 0) prediction = "Slight dip";
      else prediction = "Steady";
    }

    md.push(`| ${loc.shortName} | **${loc.pastUtilization}%** | **${loc.utilization}%** | ${trendEmoji} ${trendText} | ${prediction} |`);
  }
  md.push(``);

  // ═══════════════════════════════════════════════════════════════════════
  // GROWTH OPPORTUNITIES
  // ═══════════════════════════════════════════════════════════════════════
  const allGrowth = locationData.flatMap(l => l.highUtilShifts.map(s => ({ ...s, location: l.shortName })));

  if (allGrowth.length > 0) {
    md.push(`## 📈 Growth Opportunities (50-74% Booked)`);
    md.push(`*${dateRanges.next7Days} — Shifts becoming constraints, consider adding coverage*`);
    md.push(``);
    md.push(`| Location | Day | Time | Utilization |`);
    md.push(`|----------|-----|------|-------------|`);
    for (const shift of allGrowth.slice(0, 6)) {
      md.push(`| ${shift.location} | ${shift.day} | ${shift.bucket} | ${shift.util}% |`);
    }
    md.push(``);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADVERTISING PERFORMANCE
  // ═══════════════════════════════════════════════════════════════════════
  if (adData) {
    md.push(`## 💰 Advertising Performance`);
    md.push(`*${dateRanges.last7Days}*`);
    md.push(``);
    md.push(`**Portfolio:** $${adData.totalSpend.toFixed(0)} spent → ${adData.totalBookings} bookings → **$${adData.overallCPB.toFixed(2)} CPB**`);
    md.push(``);
    md.push(`| Channel | Spend | Bookings | CPB |`);
    md.push(`|---------|-------|----------|-----|`);
    md.push(`| Google | $${adData.totalGoogleSpend.toFixed(0)} | ${adData.totalGoogleBookings} | $${adData.googleCPB.toFixed(2)} |`);
    md.push(`| Meta | $${adData.totalMetaSpend.toFixed(0)} | ${adData.totalMetaBookings} | $${adData.metaCPB.toFixed(2)} |`);
    md.push(``);

    md.push(`### By Location`);
    md.push(``);
    md.push(`| Location | Google | G-CPB | Meta | M-CPB |`);
    md.push(`|----------|--------|-------|------|-------|`);
    for (const loc of adData.locations.sort((a, b) => b.totalSpend - a.totalSpend)) {
      const gCpb = loc.google.costPerBooking > 0 ? `$${loc.google.costPerBooking.toFixed(0)}` : "—";
      const mCpb = loc.meta.costPerBooking > 0 ? `$${loc.meta.costPerBooking.toFixed(0)}` : "—";
      md.push(`| ${loc.shortName} | $${loc.google.spend.toFixed(0)} / ${loc.google.bookings}bk | ${gCpb} | $${loc.meta.spend.toFixed(0)} / ${loc.meta.bookings}bk | ${mCpb} |`);
    }
    md.push(``);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CASH COLLECTED
  // ═══════════════════════════════════════════════════════════════════════
  const totalCashYesterday = locationData.reduce((sum, l) => sum + l.cashCollectedYesterday, 0);
  const locationsWithCash = locationData.filter(l => l.cashCollectedYesterday > 0);

  if (totalCashYesterday > 0) {
    md.push(`## 💵 Cash Collected Yesterday`);
    md.push(`*${dateRanges.yesterday}*`);
    md.push(``);
    md.push(`**Portfolio Total:** $${totalCashYesterday.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    md.push(``);
    if (locationsWithCash.length > 0) {
      md.push(`| Location | Cash |`);
      md.push(`|----------|------|`);
      for (const loc of locationsWithCash.sort((a, b) => b.cashCollectedYesterday - a.cashCollectedYesterday)) {
        md.push(`| ${loc.shortName} | $${loc.cashCollectedYesterday.toFixed(2)} |`);
      }
      md.push(``);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCR% (Location-level + Esthetician breakdown)
  // ═══════════════════════════════════════════════════════════════════════
  const locationsWithMcr = locationData.filter(l => l.locationMcr.newClients > 0);

  if (locationsWithMcr.length > 0) {
    md.push(`## 🎯 MCR% (Membership Conversion Rate)`);
    md.push(`*${dateRanges.mtd} — Memberships sold ÷ new clients seen*`);
    md.push(``);

    // Location-level MCR table
    md.push(`### By Location`);
    md.push(``);
    md.push(`| Location | MCR | Memberships | New Clients |`);
    md.push(`|----------|-----|-------------|-------------|`);
    for (const loc of locationsWithMcr.sort((a, b) => b.locationMcr.mcr - a.locationMcr.mcr)) {
      const emoji = getStatusEmoji(loc.locationMcr.mcr, [25, 50]);
      md.push(`| ${emoji} ${loc.shortName} | **${loc.locationMcr.mcr}%** | ${loc.locationMcr.memberships} | ${loc.locationMcr.newClients} |`);
    }
    md.push(``);

    // Esthetician breakdown - combined across all locations
    const combinedStaff = (bqData.combinedStaffMcr || [])
      .map((s: any) => ({
        name: s.staff,
        newClients: Number(s.new_clients),
        memberships: Number(s.memberships),
        mcr: Number(s.mcr_pct) || 0
      }))
      .sort((a: any, b: any) => b.mcr - a.mcr);

    if (combinedStaff.length > 0) {
      md.push(`### By Esthetician`);
      md.push(``);
      md.push(`| Esthetician | MCR | Memberships | New Clients |`);
      md.push(`|-------------|-----|-------------|-------------|`);
      for (const staff of combinedStaff) {
        const emoji = getStatusEmoji(staff.mcr, [25, 50]);
        md.push(`| ${emoji} ${staff.name} | **${staff.mcr}%** | ${staff.memberships} | ${staff.newClients} |`);
      }
      md.push(``);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOP SERVICES
  // ═══════════════════════════════════════════════════════════════════════
  const locationsWithServices = locationData.filter(l => l.topServices.length > 0);

  if (locationsWithServices.length > 0) {
    md.push(`## 💅 Top Services`);
    md.push(`*${dateRanges.last2Weeks}*`);
    md.push(``);

    for (const loc of locationsWithServices.slice(0, 4)) {
      md.push(`### ${loc.shortName}`);
      for (const svc of loc.topServices.slice(0, 3)) {
        md.push(`- ${svc.name}: **${svc.count}x**`);
      }
      md.push(``);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MEMBERSHIP CHURN
  // ═══════════════════════════════════════════════════════════════════════
  const yesterdayChurn = bqData.yesterdayChurn || [];
  const earlyChurnByStaff = bqData.earlyChurnByStaff || [];
  const missedExpectations = bqData.missedExpectations || [];
  const longTenureLosses = bqData.longTernureLosses || [];

  const BLVD_CLIENT_URL = "https://dashboard.boulevard.io/clients";

  const hasChurnData = yesterdayChurn.length > 0 || earlyChurnByStaff.length > 0 ||
                       missedExpectations.length > 0 || longTenureLosses.length > 0;

  if (hasChurnData) {
    md.push(`## 📉 Membership Churn`);
    md.push(``);

    // Yesterday's lost clients
    if (yesterdayChurn.length > 0) {
      md.push(`### Yesterday's Lost Clients`);
      md.push(``);
      md.push(`| Location | Client | Membership | Tenure | Reason |`);
      md.push(`|----------|--------|------------|--------|--------|`);
      for (const c of yesterdayChurn) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === c.location)?.[0] || c.location;
        const clientLink = c.client_id ? `[${c.client}](${BLVD_CLIENT_URL}/${c.client_id})` : c.client;
        md.push(`| ${shortLoc} | ${clientLink} | ${c.membership} | ${c.months} mo | ${c.reason || 'No reason'} |`);
      }
      md.push(``);
    }

    // Early churn by esthetician (MTD)
    if (earlyChurnByStaff.length > 0) {
      md.push(`### ⚠️ Early Churn by Esthetician (MTD)`);
      md.push(`*Members who cancelled within 2 months of signup*`);
      md.push(``);
      md.push(`| Esthetician | Location | Early Churns | Avg Tenure |`);
      md.push(`|-------------|----------|--------------|------------|`);
      for (const e of earlyChurnByStaff) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === e.location)?.[0] || e.location;
        md.push(`| ${e.esthetician || 'Unknown'} | ${shortLoc} | ${e.early_churns} | ${e.avg_months} mo |`);
      }
      md.push(``);
    }

    // Missed Expectations
    if (missedExpectations.length > 0) {
      md.push(`### 🚨 Missed Expectations`);
      md.push(`*Service quality issues — review immediately*`);
      md.push(``);
      for (const m of missedExpectations) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === m.location)?.[0] || m.location;
        const dateStr = m.date?.value || m.date;
        const clientLink = m.client_id ? `[${m.client}](${BLVD_CLIENT_URL}/${m.client_id})` : m.client;
        md.push(`- **${dateStr}** | ${shortLoc} | ${clientLink} | ${m.months} mo | Staff: ${m.last_staff || 'Unknown'}`);
        if (m.feedback && m.feedback !== 'NO RESPONSE') {
          md.push(`  - *"${m.feedback}"*`);
        }
      }
      md.push(``);
    }

    // Long-tenure losses (winback opportunities)
    if (longTenureLosses.length > 0) {
      md.push(`### 💔 Long-Tenure Losses (6+ months)`);
      md.push(`*Loyal members lost — reach out to win back*`);
      md.push(``);
      md.push(`| Date | Location | Client | LTV | Tenure | Reason | Email |`);
      md.push(`|------|----------|--------|-----|--------|--------|-------|`);
      for (const l of longTenureLosses) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === l.location)?.[0] || l.location;
        const dateStr = l.date?.value || l.date;
        const clientLink = l.client_id ? `[${l.client}](${BLVD_CLIENT_URL}/${l.client_id})` : l.client;
        const ltvStr = l.ltv ? `$${Number(l.ltv).toLocaleString()}` : '$0';
        md.push(`| ${dateStr} | ${shortLoc} | ${clientLink} | **${ltvStr}** | ${l.months} mo | ${l.reason || 'No reason'} | ${l.email} |`);
      }
      md.push(``);
    }
  }

  // Footer
  md.push(`---`);
  md.push(`*Generated ${new Date().toLocaleTimeString()} via \`npx tsx scripts/daily-brief-v4.ts\`*`);

  const content = md.join("\n");

  // Print to console (summarized)
  console.log("\n" + "=".repeat(60));
  console.log("DAILY BRIEF SUMMARY");
  console.log("=".repeat(60));
  console.log(`\nPortfolio: ${portfolioYesterday} bookings yesterday (${formatPercent(velocityDelta)} vs avg)`);
  console.log(`New clients: ${newClientsYesterday}`);
  console.log(`Utilization: ${avgPastUtil}% (last 7d) → ${avgFutureUtil}% (next 7d)`);
  console.log(`Capacity alerts: ${alertCount}`);
  if (adData) {
    console.log(`Ad spend: $${adData.totalSpend.toFixed(0)} → $${adData.overallCPB.toFixed(2)} CPB`);
  }
  console.log("\nRecommendations:");
  for (const rec of recommendations.slice(0, 3)) {
    console.log(`  • ${rec}`);
  }

  // Save to Obsidian — via GitHub API (Railway) or local filesystem (Mac)
  if (USE_GITHUB) {
    try {
      await pushFileToGitHub({
        repo: process.env.OBSIDIAN_REPO!,
        path: `${OBSIDIAN_REPO_PATH}/${todayStr}.md`,
        content,
        message: `daily brief ${todayStr}`,
        token: process.env.GITHUB_TOKEN!,
      });
      console.log(`\n✅ Pushed to GitHub: ${process.env.OBSIDIAN_REPO}/${OBSIDIAN_REPO_PATH}/${todayStr}.md`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ GitHub push failed: ${msg}`);
    }
  } else {
    try {
      const obsidianFile = path.join(OBSIDIAN_PATH, `${todayStr}.md`);
      if (!fs.existsSync(OBSIDIAN_PATH)) {
        fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
      }
      fs.writeFileSync(obsidianFile, content);
      console.log(`\n✅ Saved to Obsidian: ${obsidianFile}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Could not save to Obsidian: ${msg}`);
    }
  }

  // Send summary to Pronto (Utah team chat)
  if (process.env.PRONTO_API_TOKEN && process.env.PRONTO_UTAH_CHAT_ID) {
    const lines: string[] = [];

    // Header
    lines.push(`📊 Hello Sugar Utah — Daily Brief`);
    lines.push(`${dayName}\n`);

    // Action Items
    lines.push(`🎯 ACTION ITEMS`);
    if (recommendations.length === 0) {
      lines.push(`✅ No urgent actions needed today.`);
    } else {
      for (const rec of recommendations) {
        lines.push(`• ${rec}`);
      }
    }

    // Portfolio Snapshot
    lines.push(`\n📈 PORTFOLIO SNAPSHOT`);
    lines.push(`Yesterday: ${portfolioYesterday} bookings (${formatPercent(velocityDelta)} vs avg) | ${newClientsYesterday} new clients`);
    lines.push(`Utilization: ${avgPastUtil}% (last 7d) → ${avgFutureUtil}% (next 7d)`);
    if (adData) {
      lines.push(`Ads: $${adData.totalSpend.toFixed(0)} spent → ${adData.totalBookings} bookings → $${adData.overallCPB.toFixed(2)} CPB`);
    }

    // Capacity Alerts
    if (allAlerts.length > 0) {
      lines.push(`\n🚨 CAPACITY ALERTS (≥75%)`);
      for (const alert of allAlerts.slice(0, 5)) {
        lines.push(`• ${alert.location} | ${alert.day} ${alert.bucket} | ${alert.util}%`);
      }
    }

    // Booking Velocity by Location
    lines.push(`\n📅 BOOKING VELOCITY`);
    for (const loc of sortedByBookings) {
      const delta = loc.bookings7DayAvg > 0 ? Math.round(((loc.bookingsYesterday - loc.bookings7DayAvg) / loc.bookings7DayAvg) * 100) : 0;
      const emoji = delta > 20 ? "🚀" : delta < -20 ? "⚠️" : "➡️";
      lines.push(`${emoji} ${loc.shortName}: ${loc.bookingsYesterday} (${formatPercent(delta)}) | ${loc.newClientsYesterday} new`);
    }

    // Month-over-Month Revenue
    lines.push(`\n📊 MONTH-OVER-MONTH`);
    const sortedByRevenue = [...locationData].sort((a, b) => b.mtdRevenue - a.mtdRevenue);
    for (const loc of sortedByRevenue) {
      if (loc.mtdAppts === 0 && loc.lmAppts === 0 && loc.mtdRevenue === 0) continue;
      const mtdRev = loc.mtdRevenue > 0 ? `$${(loc.mtdRevenue / 1000).toFixed(1)}k` : "—";
      const lmRev = loc.lmRevenue > 0 ? `$${(loc.lmRevenue / 1000).toFixed(1)}k` : "—";
      const revIcon = loc.mtdRevenue >= loc.lmRevenue ? "🟢" : "🔴";
      lines.push(`${revIcon} ${loc.shortName}: ${mtdRev}/${lmRev} rev | ${loc.mtdAppts}/${loc.lmAppts} appts | ${loc.mtdNew}/${loc.lmNew} new`);
    }

    // Utilization Comparison
    lines.push(`\n🏆 UTILIZATION`);
    for (const loc of locationData) {
      const trendEmoji = loc.utilizationTrend === null ? "—" :
        loc.utilizationTrend > 5 ? "📈" : loc.utilizationTrend < -5 ? "📉" : "➡️";
      lines.push(`${loc.shortName}: ${loc.pastUtilization}% → ${loc.utilization}% ${trendEmoji}`);
    }

    // Ad Performance by Location
    if (adData && adData.locations.length > 0) {
      lines.push(`\n💰 ADS BY LOCATION`);
      lines.push(`Google: $${adData.totalGoogleSpend.toFixed(0)} → ${adData.totalGoogleBookings}bk ($${adData.googleCPB.toFixed(2)} CPB)`);
      lines.push(`Meta: $${adData.totalMetaSpend.toFixed(0)} → ${adData.totalMetaBookings}bk ($${adData.metaCPB.toFixed(2)} CPB)`);
      for (const loc of adData.locations.sort((a, b) => b.totalSpend - a.totalSpend)) {
        const gCpb = loc.google.costPerBooking > 0 ? `$${loc.google.costPerBooking.toFixed(0)}` : "—";
        const mCpb = loc.meta.costPerBooking > 0 ? `$${loc.meta.costPerBooking.toFixed(0)}` : "—";
        lines.push(`• ${loc.shortName}: G $${loc.google.spend.toFixed(0)}/${loc.google.bookings}bk (${gCpb}) | M $${loc.meta.spend.toFixed(0)}/${loc.meta.bookings}bk (${mCpb})`);
      }
    }

    // MCR by Location
    if (locationsWithMcr.length > 0) {
      lines.push(`\n🎯 MCR% (Membership Conversion)`);
      for (const loc of locationsWithMcr.sort((a, b) => b.locationMcr.mcr - a.locationMcr.mcr)) {
        const emoji = loc.locationMcr.mcr >= 50 ? "🟢" : loc.locationMcr.mcr >= 25 ? "🟡" : "🔴";
        lines.push(`${emoji} ${loc.shortName}: ${loc.locationMcr.mcr}% (${loc.locationMcr.memberships}/${loc.locationMcr.newClients})`);
      }
    }

    // MCR by Esthetician
    const combinedStaffForPronto = (bqData.combinedStaffMcr || [])
      .map((s: Record<string, unknown>) => ({
        name: s.staff as string,
        newClients: Number(s.new_clients),
        memberships: Number(s.memberships),
        mcr: Number(s.mcr_pct) || 0,
      }))
      .sort((a: { mcr: number }, b: { mcr: number }) => b.mcr - a.mcr);

    if (combinedStaffForPronto.length > 0) {
      lines.push(`\nMCR by Esthetician:`);
      for (const staff of combinedStaffForPronto) {
        const emoji = staff.mcr >= 50 ? "🟢" : staff.mcr >= 25 ? "🟡" : "🔴";
        lines.push(`${emoji} ${staff.name}: ${staff.mcr}% (${staff.memberships}/${staff.newClients})`);
      }
    }

    // Membership Churn
    if (yesterdayChurn.length > 0) {
      lines.push(`\n📉 YESTERDAY'S CHURN`);
      for (const c of yesterdayChurn) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === c.location)?.[0] || c.location;
        lines.push(`• ${shortLoc} | ${c.client} | ${c.membership} | ${c.months} mo | ${c.reason || "No reason"}`);
      }
    }

    // Early Churn by Esthetician
    if (earlyChurnByStaff.length > 0) {
      lines.push(`\n⚠️ EARLY CHURN BY ESTHETICIAN (MTD)`);
      for (const e of earlyChurnByStaff) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === e.location)?.[0] || e.location;
        lines.push(`• ${e.staff} (${shortLoc}): ${e.early_churns} early | avg ${e.avg_tenure} mo`);
      }
    }

    // Missed Expectations
    if (missedExpectations.length > 0) {
      lines.push(`\n🚨 MISSED EXPECTATIONS`);
      for (const m of missedExpectations) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === m.location)?.[0] || m.location;
        const dateStr = m.date?.value || m.date;
        lines.push(`• ${dateStr} | ${shortLoc} | ${m.client} | ${m.months} mo | Staff: ${m.last_staff || "Unknown"}`);
      }
    }

    // Long-Tenure Losses
    if (longTenureLosses.length > 0) {
      lines.push(`\n💔 LONG-TENURE LOSSES (6+ mo)`);
      for (const l of longTenureLosses) {
        const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === l.location)?.[0] || l.location;
        const ltvStr = l.ltv ? `$${Number(l.ltv).toLocaleString()}` : "$0";
        lines.push(`• ${shortLoc} | ${l.client} | ${ltvStr} LTV | ${l.months} mo | ${l.reason || "No reason"}`);
      }
    }

    const summary = lines.join("\n");

    try {
      await sendProntoMessage({
        chatId: process.env.PRONTO_UTAH_CHAT_ID,
        message: summary,
        token: process.env.PRONTO_API_TOKEN,
      });
      console.log(`\n✅ Sent summary to Pronto`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Pronto send failed: ${msg}`);
    }
  }
}

// Accept date argument: npx tsx scripts/daily-brief-v4.ts 2026-03-15
const dateArg = process.argv[2];
generateBrief(dateArg).catch(console.error);

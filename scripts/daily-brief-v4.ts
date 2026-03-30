import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { BigQuery } from "@google-cloud/bigquery";
import { getAdPerformance, type PortfolioAdSummary } from "../lib/bigquery";
import { getAppointments, getShifts, getStaff } from "../lib/boulevard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bootstrap Google Cloud credentials from env var (for Railway)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const tmpPath = path.join(os.tmpdir(), "gcp-credentials.json");
  fs.writeFileSync(tmpPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

// Obsidian output — local path or GitHub API
const OBSIDIAN_PATH = path.join(os.homedir(), "Obsidian Vaults/Austin's Brain/Hello Sugar/Daily Briefing");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OBSIDIAN_REPO = process.env.OBSIDIAN_REPO; // e.g. "austintowns/obsidian-vault"
const OBSIDIAN_BRANCH = process.env.OBSIDIAN_BRANCH || "main";
const OBSIDIAN_BASE_PATH = "Austin's Brain/Hello Sugar"; // path prefix inside the repo

async function githubPutFile(filePath: string, content: string): Promise<void> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encodedPath}`;
  // Check if file exists to get its sha (needed for updates)
  let sha: string | undefined;
  const getRes = await fetch(url, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
  });
  if (getRes.ok) {
    const data = await getRes.json() as { sha: string };
    sha = data.sha;
  }
  const body: Record<string, string> = {
    message: `Daily brief update: ${filePath}`,
    content: Buffer.from(content).toString("base64"),
    branch: OBSIDIAN_BRANCH,
  };
  if (sha) body.sha = sha;
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub API error (${putRes.status}): ${err}`);
  }
}

async function githubGetFile(filePath: string): Promise<string | null> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${OBSIDIAN_REPO}/contents/${encodedPath}?ref=${OBSIDIAN_BRANCH}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) return null;
  const data = await res.json() as { content: string };
  return Buffer.from(data.content, "base64").toString("utf-8");
}

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

// Pronto integration
const PRONTO_API_TOKEN = process.env.PRONTO_API_TOKEN;
const PRONTO_UTAH_CHAT_ID = process.env.PRONTO_UTAH_CHAT_ID || "5343834";

async function postToPronto(message: string): Promise<void> {
  if (!PRONTO_API_TOKEN) {
    console.log("  ⚠ PRONTO_API_TOKEN not set, skipping Pronto post");
    return;
  }
  const response = await fetch(`https://api.pronto.io/api/chats/${PRONTO_UTAH_CHAT_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PRONTO_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ text: message }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pronto API error (${response.status}): ${errorText}`);
  }
}

// Retention offer tiers
interface RetentionOffer {
  tier: number;
  monthlyLtv: number;
  options: string[];
}

function getRetentionOffer(ltv: number, months: number, services: { hasBrazilian: boolean; hasUnderarms: boolean; hasBrows: boolean }): RetentionOffer {
  const monthlyLtv = months > 0 ? ltv / months : 0;

  if (monthlyLtv < 45 || ltv < 330) {
    return { tier: 3, monthlyLtv, options: [] };
  }

  if (monthlyLtv >= 100 && ltv >= 600) {
    const options: string[] = [];
    if (services.hasBrazilian && !services.hasUnderarms && !services.hasBrows) {
      options.push("Free Underarms OR Brows 3mo");
      options.push("Free Laser Combo (2 Med + UA) — $120 value");
      options.push("10% off next appointment*");
    } else if (services.hasBrazilian && services.hasUnderarms && !services.hasBrows) {
      options.push("Free Underarms 3mo");
      options.push("Free Brows 3mo");
      options.push("10% off next appointment*");
    } else if (services.hasBrazilian && services.hasUnderarms && services.hasBrows) {
      options.push("Free Underarms 3mo");
      options.push("Free Brows 3mo");
      options.push("Free Laser Combo (2 Med + UA) — $120 value");
      options.push("10% off next appointment*");
    } else {
      options.push("Free Underarms 3mo");
      options.push("10% off next appointment*");
      options.push("Free Laser Medium Combo — $120 value");
    }
    return { tier: 1, monthlyLtv, options };
  }

  return {
    tier: 2,
    monthlyLtv,
    options: ["Free Underarms OR Brows 3mo", "Free Laser on any one area"]
  };
}

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
  futureDailyUtil: DayUtilization[];
  pastDailyUtil: DayUtilization[];
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
    // Long-tenure losses (6+ months, last 30 days)
    // - excludes clients with future appointments
    // - excludes laser converts (reason mentions laser AND has recent laser booking)
    // - includes last appointment date and service history for retention offers
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
        last_appt AS (
          SELECT
            CLIENT_ID as client_id,
            MAX(APPT_SCHED_DATE_CLEANED) as last_appt_date
          FROM \`${DATASET}.tbl_adhoc_all_bookings_partitioned\`
          WHERE APPT_SCHED_DATE_CLEANED < ${TARGET_DATE}
            AND CANCELLED_DATE IS NULL
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
            la.last_appt_date,
            ROW_NUMBER() OVER (PARTITION BY c._COL_10 ORDER BY CAST(c._COL_4 AS INT64) DESC) as rn
          FROM \`${DATASET}.tbl_non_active_membership_with_response\` c
          LEFT JOIN active_clients ac ON c._COL_10 = ac.CLIENT_ID
          LEFT JOIN clients_with_future_appts fa ON c._COL_10 = fa.CLIENT_ID
          LEFT JOIN client_ltv cl ON c._COL_10 = cl.client_id
          LEFT JOIN last_appt la ON c._COL_10 = la.client_id
          WHERE c._COL_14 IN (${OWNED_LOCATIONS_SQL})
            AND c._COL_5 = 'CANCELLED'
            AND CAST(c._COL_4 AS INT64) >= 6
            AND c._COL_0 >= DATE_SUB(${TARGET_DATE}, INTERVAL 30 DAY)
            AND ac.CLIENT_ID IS NULL
            AND fa.CLIENT_ID IS NULL
        )
        SELECT client_id, date, location, client, email, membership, months, reason, feedback, ltv, last_appt_date
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
// UTILIZATION CALCULATION
// Boulevard formula: Hours Booked / (Hours Scheduled - Business Blocked Hours)
// - Uses library getShifts() which already excludes null staffId (laser resources)
//   and correctly expands recurring templates with recurrence date checks
// - BTB blocks are not counted as blocked time (they represent unfilled capacity)
// ═══════════════════════════════════════════════════════════════════════════

interface BlvdAppointment {
  startAt: string;
  endAt: string;
  cancelled: boolean;
  state: string;
  appointmentServices?: { staff?: { id: string; name: string } }[];
}

interface BucketData {
  scheduledMin: number;
  blockedMin: number;
  bookedMin: number;
}

interface DayUtilization {
  dateStr: string;       // YYYY-MM-DD
  dayName: string;       // Mon, Tue, etc.
  scheduledMin: number;
  blockedMin: number;
  bookedMin: number;
  utilization: number;   // percentage
  am: BucketData & { utilization: number };  // 8am-2pm
  pm: BucketData & { utilization: number };  // 2pm-8pm
}

function toMountainDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

function calculateUtilization(
  expandedShifts: { staffId: string; date: string; startAt: string; endAt: string }[],
  blocks: Timeblock[],
  blvdAppts: BlvdAppointment[],
  periodStartStr: string,
  periodEndStr: string
) {
  const AM_BOUNDARY = 14; // 2pm: AM = 8am-2pm, PM = 2pm-8pm

  // Collect valid staffIds from expanded shifts
  const validStaffIds = new Set<string>();
  for (const shift of expandedShifts) {
    validStaffIds.add(shift.staffId);
  }

  // Build per-date, per-bucket totals
  const emptyBucket = (): BucketData => ({ scheduledMin: 0, blockedMin: 0, bookedMin: 0 });
  const dayData = new Map<string, { am: BucketData; pm: BucketData }>();

  // Initialize each date in the period
  let d = new Date(periodStartStr + "T12:00:00-06:00");
  const end = new Date(periodEndStr + "T12:00:00-06:00");
  while (d <= end) {
    dayData.set(d.toISOString().split("T")[0], { am: emptyBucket(), pm: emptyBucket() });
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }

  // Helper: split a time range into AM/PM minutes
  function splitIntoBuckets(startHour: number, endHour: number): { amMin: number; pmMin: number } {
    const amStart = Math.max(8, startHour);
    const amEnd = Math.min(AM_BOUNDARY, endHour);
    const pmStart = Math.max(AM_BOUNDARY, startHour);
    const pmEnd = Math.min(20, endHour);
    return {
      amMin: Math.max(0, amEnd - amStart) * 60,
      pmMin: Math.max(0, pmEnd - pmStart) * 60,
    };
  }

  // 1. SCHEDULED: shifts are already expanded by date with recurrence handled
  for (const shift of expandedShifts) {
    if (!dayData.has(shift.date)) continue;
    const [h1, m1] = shift.startAt.split("T")[1].split(":").map(Number);
    const [h2, m2] = shift.endAt.split("T")[1].split(":").map(Number);
    const startHour = h1 + m1 / 60;
    const endHour = h2 + m2 / 60;
    const { amMin, pmMin } = splitIntoBuckets(startHour, endHour);
    const day = dayData.get(shift.date)!;
    day.am.scheduledMin += amMin;
    day.pm.scheduledMin += pmMin;
  }

  // 2. BLOCKED: business blocks (not BTB) on real staff
  for (const block of blocks) {
    if (isBTBBlock(block)) continue;
    if (block.cancelled) continue;

    const blockStart = new Date(block.startAt);
    const dateStr = toMountainDateStr(blockStart);
    if (!dayData.has(dateStr)) continue;

    const rawStaffId = block.staff?.id;
    if (rawStaffId) {
      const staffId = rawStaffId.replace("urn:blvd:Staff:", "");
      if (!validStaffIds.has(staffId)) continue;
    }

    // Determine bucket by block start hour in Mountain Time
    const mstHour = Number(blockStart.toLocaleString("en-US", { timeZone: "America/Denver", hour: "numeric", hour12: false }));
    const bucket = mstHour < AM_BOUNDARY ? "am" : "pm";
    dayData.get(dateStr)![bucket].blockedMin += block.duration || 0;
  }

  // 3. BOOKED: Boulevard appointments (actual slot time: endAt - startAt)
  for (const apt of blvdAppts) {
    if (apt.cancelled || apt.state === "CANCELLED") continue;

    const aptStart = new Date(apt.startAt);
    const aptEnd = new Date(apt.endAt);

    const aptStaffIds = (apt.appointmentServices || [])
      .map(s => s.staff?.id?.replace("urn:blvd:Staff:", ""))
      .filter(Boolean) as string[];
    const hasRealStaff = aptStaffIds.some(id => validStaffIds.has(id));
    if (!hasRealStaff) continue;

    const slotMinutes = (aptEnd.getTime() - aptStart.getTime()) / (1000 * 60);
    if (slotMinutes <= 0) continue;

    const dateStr = toMountainDateStr(aptStart);
    if (!dayData.has(dateStr)) continue;

    // Split appointment into AM/PM based on actual start/end times
    const startMst = new Date(aptStart.toLocaleString("en-US", { timeZone: "America/Denver" }));
    const endMst = new Date(aptEnd.toLocaleString("en-US", { timeZone: "America/Denver" }));
    const startH = startMst.getHours() + startMst.getMinutes() / 60;
    const endH = endMst.getHours() + endMst.getMinutes() / 60;
    const { amMin, pmMin } = splitIntoBuckets(startH, endH);
    const day = dayData.get(dateStr)!;
    day.am.bookedMin += amMin;
    day.pm.bookedMin += pmMin;
  }

  // Calculate per-day utilization and totals
  let totalScheduled = 0, totalBooked = 0, totalBlocked = 0;
  const dailyUtil: DayUtilization[] = [];

  function calcUtil(b: BucketData): number {
    const avail = Math.max(0, b.scheduledMin - b.blockedMin);
    return avail > 0 ? Math.min(100, Math.round((b.bookedMin / avail) * 100)) : 0;
  }

  for (const [dateStr, data] of [...dayData.entries()].sort()) {
    const sched = data.am.scheduledMin + data.pm.scheduledMin;
    const block = data.am.blockedMin + data.pm.blockedMin;
    const booked = data.am.bookedMin + data.pm.bookedMin;
    const available = Math.max(0, sched - block);
    const util = available > 0 ? Math.min(100, Math.round((booked / available) * 100)) : 0;
    totalScheduled += sched;
    totalBooked += booked;
    totalBlocked += block;

    const dateObj = new Date(dateStr + "T12:00:00-06:00");
    dailyUtil.push({
      dateStr,
      dayName: dayNames[dateObj.getDay()],
      scheduledMin: sched,
      blockedMin: block,
      bookedMin: booked,
      utilization: util,
      am: { ...data.am, utilization: calcUtil(data.am) },
      pm: { ...data.pm, utilization: calcUtil(data.pm) },
    });
  }

  const availableTotal = Math.max(0, totalScheduled - totalBlocked);
  const utilization = availableTotal > 0 ? Math.round((totalBooked / availableTotal) * 100) : 0;

  // Derive capacity alerts and growth opportunities from daily data
  const alerts = dailyUtil
    .filter(d => d.utilization >= 75 && (d.scheduledMin - d.blockedMin) > 60)
    .sort((a, b) => b.utilization - a.utilization)
    .slice(0, 5)
    .map(d => ({ staff: "", day: d.dayName, bucket: `${(d.bookedMin/60).toFixed(1)}h/${((d.scheduledMin - d.blockedMin)/60).toFixed(1)}h`, util: d.utilization }));

  const growth = dailyUtil
    .filter(d => d.utilization >= 50 && d.utilization < 75 && (d.scheduledMin - d.blockedMin) > 60)
    .sort((a, b) => b.utilization - a.utilization)
    .slice(0, 5)
    .map(d => ({ staff: "", day: d.dayName, bucket: `${(d.bookedMin/60).toFixed(1)}h/${((d.scheduledMin - d.blockedMin)/60).toFixed(1)}h`, util: d.utilization }));

  return {
    utilization,
    scheduledMinutes: totalScheduled,
    bookedMinutes: totalBooked,
    blockedMinutes: totalBlocked,
    dailyUtil,
    highUtilShifts: growth,
    capacityAlerts: alerts,
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
  let today: Date;
  if (targetDateStr) {
    today = new Date(targetDateStr + "T12:00:00-06:00");
  } else {
    // Evaluate yesterday in Mountain Time (the brief reviews the prior day)
    const nowLocal = new Date().toLocaleString("en-CA", { timeZone: "America/Denver", hour12: false });
    const localDateStr = nowLocal.split(",")[0]; // YYYY-MM-DD
    const localToday = new Date(localDateStr + "T12:00:00-06:00");
    today = new Date(localToday.getTime() - 24 * 60 * 60 * 1000);
  }
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

  console.log("Fetching Boulevard staff (once)...");
  // Fetch all staff once to avoid redundant API calls (was called 14x before)
  const allStaff = await getStaff();
  const staffMapsByLocation = new Map<string, Map<string, any>>();
  for (const loc of config.owned) {
    const normalizedLocId = loc.id.replace("urn:blvd:Location:", "");
    const locStaff = allStaff.filter((s: any) =>
      s.locations?.some((l: any) => l.id.replace("urn:blvd:Location:", "") === normalizedLocId)
    );
    staffMapsByLocation.set(loc.id, new Map(
      locStaff.map((s: any) => [s.id.replace("urn:blvd:Staff:", ""), s])
    ));
  }
  console.log(`  ✓ ${allStaff.length} staff members`);

  console.log("Fetching Boulevard shifts, blocks & appointments...");
  // Period date strings for utilization calculation
  const futureStartStr = todayStr;
  const futureEndStr = sevenDaysOutStr;
  const pastStartStr = sevenDaysAgoStr;
  const pastEndStr = todayStr;

  // Fetch shifts once per location for the full range, split locally into past/future
  // Pass pre-loaded staff map to avoid redundant getStaff() calls
  const blvdPromises = config.owned.map((loc: any) => {
    const staffMap = staffMapsByLocation.get(loc.id)!;
    return Promise.all([
      getShifts(loc.id, sevenDaysAgoStr, sevenDaysOutStr, undefined, staffMap), // ONE call, split locally
      fetchBlocksForLocation(loc.id, sevenDaysAgoStr, sevenDaysOutStr),
      fetchDailyCash(loc.id, yesterdayStr),
      getAppointments(loc.id, sevenDaysAgoStr, sevenDaysOutStr, undefined, 2000),
    ]).then(([allShifts, blocks, cashCents, appointments]) => ({
      shortName: loc.shortName,
      blvdId: loc.id,
      pastShifts: allShifts.filter((s: any) => s.date >= pastStartStr && s.date < pastEndStr),
      futureShifts: allShifts.filter((s: any) => s.date >= futureStartStr && s.date <= futureEndStr),
      blocks,
      cashCents,
      appointments,
    }));
  });
  const allBlvdData = await Promise.all(blvdPromises);
  const totalShifts = allBlvdData.reduce((sum, l) => sum + l.pastShifts.length + l.futureShifts.length, 0);
  const totalBlocks = allBlvdData.reduce((sum, l) => sum + l.blocks.length, 0);
  const totalCash = allBlvdData.reduce((sum, l) => sum + l.cashCents, 0);
  const totalAppts = allBlvdData.reduce((sum, l) => sum + l.appointments.length, 0);
  console.log(`  ✓ ${totalShifts} shifts, ${totalBlocks} blocks, ${totalAppts} appts, $${(totalCash / 100).toFixed(0)} cash yesterday`);

  // Fetch ad data
  console.log("Fetching advertising data...");
  const shortNames = config.owned.map((l: any) => l.shortName);
  let adData: PortfolioAdSummary | null = null;
  try {
    adData = await getAdPerformance(shortNames, 7, todayStr);
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
      locData.futureShifts,
      locData.blocks,
      locData.appointments,
      futureStartStr,
      futureEndStr
    );

    // Past utilization (last 7 days - actual)
    const pastUtilData = calculateUtilization(
      locData.pastShifts,
      locData.blocks,
      locData.appointments,
      pastStartStr,
      pastEndStr
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
      futureDailyUtil: futureUtilData.dailyUtil,
      pastDailyUtil: pastUtilData.dailyUtil,
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
  // Count AM/PM shifts at capacity (≥75%)
  let alertCount = 0;
  for (const loc of locationData) {
    for (const d of loc.futureDailyUtil) {
      if (d.am.utilization >= 75 && (d.am.scheduledMin - d.am.blockedMin) > 60) alertCount++;
      if (d.pm.utilization >= 75 && (d.pm.scheduledMin - d.pm.blockedMin) > 60) alertCount++;
    }
  }
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
  md.push(`## 🏆 Utilization Overview`);
  md.push(`*Boulevard formula: Hours Booked ÷ (Hours Scheduled - Business Blocked Hours)*`);
  md.push(``);

  // Weekly summary table
  md.push(`### Weekly Summary`);
  md.push(`*Last 7d (${dateRanges.last7Days}) vs Next 7d (${dateRanges.next7Days})*`);
  md.push(``);
  md.push(`| Location | Last 7d | Next 7d | Trend |`);
  md.push(`|----------|---------|---------|-------|`);

  for (const loc of locationData) {
    const trendEmoji = loc.utilizationTrend === null ? "—" :
      loc.utilizationTrend > 5 ? "📈" :
      loc.utilizationTrend < -5 ? "📉" : "➡️";
    const trendText = loc.utilizationTrend !== null ? `${loc.utilizationTrend > 0 ? "+" : ""}${loc.utilizationTrend}%` : "—";
    md.push(`| ${loc.shortName} | **${loc.pastUtilization}%** | **${loc.utilization}%** | ${trendEmoji} ${trendText} |`);
  }
  md.push(``);

  // Format a utilization cell: "65%" bold if ≥75, normal otherwise, "—" if no shift
  const fmtUtil = (u: number, sched: number) => {
    if (sched === 0) return "—";
    if (u >= 75) return `**${u}%**`;
    return `${u}%`;
  };

  // Emoji for a single utilization value
  const utilDot = (u: number, sched: number) => {
    if (sched === 0) return "—";
    if (u >= 75) return `🔴${u}`;
    if (u >= 50) return `🟡${u}`;
    if (u > 0) return `🟢${u}`;
    return "0";
  };

  // Helper: build grid with separate AM/PM rows per location
  function buildUtilGrid(
    dates: string[],
    getDailyUtil: (loc: typeof locationData[0]) => DayUtilization[],
    getAvg: (loc: typeof locationData[0]) => number
  ) {
    const headers = dates.map(ds => {
      const d = new Date(ds + "T12:00:00-06:00");
      return `${dayNames[d.getDay()]} ${ds.slice(5)}`;
    });

    md.push(`| Location | Shift | ${headers.join(" | ")} | Avg |`);
    md.push(`|----------|-------|${headers.map(() => "---:").join("|")}|---:|`);

    for (const loc of locationData) {
      const dayMap = new Map(getDailyUtil(loc).map(d => [d.dateStr, d]));
      const amCells = dates.map(ds => {
        const d = dayMap.get(ds);
        if (!d) return "—";
        return utilDot(d.am.utilization, d.am.scheduledMin);
      });
      const pmCells = dates.map(ds => {
        const d = dayMap.get(ds);
        if (!d) return "—";
        return utilDot(d.pm.utilization, d.pm.scheduledMin);
      });
      md.push(`| **${loc.shortName}** | 8a-2p | ${amCells.join(" | ")} | **${getAvg(loc)}%** |`);
      md.push(`| | 2p-8p | ${pmCells.join(" | ")} | |`);
    }
    md.push(``);
  }

  // ── LAST 7 DAYS ──
  const pastDates = [...new Set(locationData.flatMap(l =>
    l.pastDailyUtil.filter(d => d.scheduledMin > 0).map(d => d.dateStr)
  ))].sort();

  if (pastDates.length > 0) {
    md.push(`### Last 7 Days (${dateRanges.last7Days})`);
    md.push(`*🔴 ≥75% 🟡 ≥50% 🟢 <50%*`);
    md.push(``);
    buildUtilGrid(pastDates, l => l.pastDailyUtil, l => l.pastUtilization);
  }

  // ── NEXT 7 DAYS ──
  const futureDates = [...new Set(locationData.flatMap(l =>
    l.futureDailyUtil.filter(d => d.scheduledMin > 0).map(d => d.dateStr)
  ))].sort();

  if (futureDates.length > 0) {
    md.push(`### Next 7 Days (${dateRanges.next7Days})`);
    md.push(`*🔴 ≥75% 🟡 ≥50% 🟢 <50%*`);
    md.push(``);
    buildUtilGrid(futureDates, l => l.futureDailyUtil, l => l.utilization);

    // Hours detail — collapsible
    md.push(`<details><summary>Hours breakdown (available / booked per shift)</summary>`);
    md.push(``);
    md.push(`| Location | Day | Shift | Avail | Booked |`);
    md.push(`|----------|-----|-------|-------|--------|`);
    for (const loc of locationData) {
      for (const d of loc.futureDailyUtil.filter(dd => dd.scheduledMin > 0)) {
        const day = `${d.dayName} ${d.dateStr.slice(5)}`;
        if (d.am.scheduledMin > 0) {
          const avail = (Math.max(0, d.am.scheduledMin - d.am.blockedMin) / 60).toFixed(1);
          const booked = (d.am.bookedMin / 60).toFixed(1);
          md.push(`| ${loc.shortName} | ${day} | 8a-2p | ${avail}h | ${booked}h |`);
        }
        if (d.pm.scheduledMin > 0) {
          const avail = (Math.max(0, d.pm.scheduledMin - d.pm.blockedMin) / 60).toFixed(1);
          const booked = (d.pm.bookedMin / 60).toFixed(1);
          md.push(`| ${loc.shortName} | ${day} | 2p-8p | ${avail}h | ${booked}h |`);
        }
      }
    }
    md.push(``);
    md.push(`</details>`);
    md.push(``);
  }

  // ── SHIFTS NEEDING ATTENTION ──
  // Collect all AM/PM shifts with notable utilization
  interface ShiftAlert { location: string; day: string; shift: string; util: number; booked: string; avail: string }
  const capacityShifts: ShiftAlert[] = [];
  const growthShifts: ShiftAlert[] = [];

  for (const loc of locationData) {
    for (const d of loc.futureDailyUtil) {
      for (const [label, bucket] of [["8a-2p", d.am], ["2p-8p", d.pm]] as const) {
        const avail = Math.max(0, bucket.scheduledMin - bucket.blockedMin);
        if (avail <= 60) continue;
        const entry: ShiftAlert = {
          location: loc.shortName,
          day: `${d.dayName} ${d.dateStr.slice(5)}`,
          shift: label,
          util: bucket.utilization,
          booked: `${(bucket.bookedMin / 60).toFixed(1)}h`,
          avail: `${(avail / 60).toFixed(1)}h`,
        };
        if (bucket.utilization >= 75) capacityShifts.push(entry);
        else if (bucket.utilization >= 50) growthShifts.push(entry);
      }
    }
  }

  if (capacityShifts.length > 0 || growthShifts.length > 0) {
    md.push(`### Shifts Needing Attention`);
    md.push(``);
  }

  if (capacityShifts.length > 0) {
    capacityShifts.sort((a, b) => b.util - a.util);
    md.push(`**At Capacity (≥75%) — add coverage or open waitlist**`);
    md.push(``);
    md.push(`| Location | Day | Shift | Avail | Booked | Util |`);
    md.push(`|----------|-----|-------|-------|--------|------|`);
    for (const s of capacityShifts.slice(0, 10)) {
      md.push(`| ${s.location} | ${s.day} | ${s.shift} | ${s.avail} | ${s.booked} | **${s.util}%** |`);
    }
    md.push(``);
  }

  if (growthShifts.length > 0) {
    growthShifts.sort((a, b) => b.util - a.util);
    md.push(`**Filling Up (50-74%) — watch these, may need coverage soon**`);
    md.push(``);
    md.push(`| Location | Day | Shift | Avail | Booked | Util |`);
    md.push(`|----------|-----|-------|-------|--------|------|`);
    for (const s of growthShifts.slice(0, 10)) {
      md.push(`| ${s.location} | ${s.day} | ${s.shift} | ${s.avail} | ${s.booked} | ${s.util}% |`);
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
  // Populated in the retention section, used for Pronto message
  const retentionForPronto: { client: string; clientId: string; location: string; ltv: number; email: string; offer: RetentionOffer; reason: string; churnDate: string; lastAppt: string }[] = [];

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

    // Long-tenure losses (winback opportunities) with retention tiers
    if (longTenureLosses.length > 0) {
      // Filter: skip laser converts and clients with last visit > 3 months ago
      const threeMonthsAgo = new Date(today);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const threeMonthsAgoStr = threeMonthsAgo.toISOString().split("T")[0];

      const laserConverts: any[] = [];
      const retentionCandidates: any[] = [];

      for (const l of longTenureLosses) {
        const reasonMentionsLaser = (l.reason || "").toLowerCase().includes("laser") ||
          (l.feedback || "").toLowerCase().includes("laser");

        // Skip laser converts — reason mentions laser (likely upgraded internally)
        if (reasonMentionsLaser) {
          laserConverts.push(l);
          continue;
        }

        // Skip clients whose last appointment was over 3 months ago
        const lastApptDate = l.last_appt_date?.value || l.last_appt_date;
        if (!lastApptDate || lastApptDate < threeMonthsAgoStr) {
          continue;
        }

        retentionCandidates.push(l);
      }

      if (laserConverts.length > 0) {
        md.push(`### 🔄 Laser Converts (excluded from churn)`);
        md.push(`*These clients cancelled wax/sugar but upgraded to laser internally*`);
        md.push(``);
        for (const l of laserConverts) {
          const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === l.location)?.[0] || l.location;
          const clientLink = l.client_id ? `[${l.client}](${BLVD_CLIENT_URL}/${l.client_id})` : l.client;
          md.push(`- ${clientLink} (${shortLoc}) — $${Number(l.ltv).toLocaleString()} LTV`);
        }
        md.push(``);
      }

      if (retentionCandidates.length > 0) {
        md.push(`### 💔 Retention Opportunities (6+ mo tenure, visited within 3 mo)`);
        md.push(`*Tier 1: $100+/mo & $600+ LTV | Tier 2: $45+/mo & $330+ LTV | Tier 3: no offer*`);
        md.push(``);

        for (const l of retentionCandidates) {
          const shortLoc = Object.entries(LOCATION_NAME_MAP).find(([_, bq]) => bq === l.location)?.[0] || l.location;
          const dateStr = l.date?.value || l.date;
          const lastAppt = l.last_appt_date?.value || l.last_appt_date;
          const clientLink = l.client_id ? `[${l.client}](${BLVD_CLIENT_URL}/${l.client_id})` : l.client;
          const ltvNum = Number(l.ltv) || 0;
          const monthsNum = Number(l.months) || 1;
          // Infer service history from membership name (service_history query TBD)
          const membership = (l.membership || "").toLowerCase();
          const services = {
            hasBrazilian: membership.includes("brazilian"),
            hasUnderarms: membership.includes("underarm"),
            hasBrows: membership.includes("brow"),
          };
          const offer = getRetentionOffer(ltvNum, monthsNum, services);

          md.push(`**${clientLink}** — ${shortLoc} | **$${ltvNum.toLocaleString()} LTV** | $${Math.round(offer.monthlyLtv)}/mo | ${monthsNum} mo | Tier ${offer.tier}`);
          md.push(`- Cancelled: ${dateStr} | Last visit: ${lastAppt || 'Unknown'} | Reason: ${l.reason || 'No reason'}`);
          md.push(`- Email: ${l.email}`);
          if (offer.options.length > 0) {
            md.push(`- **Offer one of:**`);
            for (const opt of offer.options) {
              md.push(`  - ${opt}`);
            }
          }
          md.push(``);

          // Collect for Pronto message
          if (offer.tier <= 2) {
            retentionForPronto.push({
              client: l.client, clientId: l.client_id, location: shortLoc,
              ltv: ltvNum, email: l.email, offer,
              reason: l.reason || 'No reason given',
              churnDate: dateStr, lastAppt: lastAppt || 'Unknown',
            });
          }
        }
      }
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

  // Save to Obsidian (local or GitHub)
  if (GITHUB_TOKEN && OBSIDIAN_REPO) {
    // Railway / remote: use GitHub API
    try {
      await githubPutFile(`${OBSIDIAN_BASE_PATH}/Daily Briefing/${todayStr}.md`, content);
      console.log(`\n✅ Pushed to GitHub: ${OBSIDIAN_REPO} — Daily Briefing/${todayStr}.md`);
    } catch (err: any) {
      console.error(`\n❌ Could not push to GitHub: ${err.message}`);
    }

    // Append ≥60% shifts to Capacity Log via GitHub
    try {
      const capacityPath = `${OBSIDIAN_BASE_PATH}/Capacity Log.md`;
      let log = await githubGetFile(capacityPath);
      if (log) {
        let added = 0;
        const locations = ["Bountiful", "Farmington", "Heber City", "Ogden", "Riverton", "Sugar House", "West Valley"];
        const fullDayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

        for (const locName of locations) {
          const loc = locationData.find(l => l.shortName === locName);
          if (!loc) continue;
          for (const d of loc.pastDailyUtil) {
            for (const [label, bucket] of [["8a-2p", d.am], ["2p-8p", d.pm]] as const) {
              const avail = Math.max(0, bucket.scheduledMin - bucket.blockedMin);
              if (bucket.utilization < 60 || avail <= 60) continue;
              const entry = `| ${d.dateStr} | ${label} | ${bucket.utilization}% | ${(avail / 60).toFixed(1)}h | ${(bucket.bookedMin / 60).toFixed(1)}h |`;
              if (log.includes(entry)) continue;
              const locHeading = `## ${locName}`;
              const locIdx = log.indexOf(locHeading);
              if (locIdx === -1) continue;
              const dayHeading = `### ${fullDayNames[new Date(d.dateStr + "T12:00:00-06:00").getDay()]}`;
              const dayIdx = log.indexOf(dayHeading, locIdx);
              if (dayIdx === -1) continue;
              const afterDay = log.indexOf("\n", dayIdx) + 1;
              let tableEnd = log.indexOf("\n\n", afterDay);
              if (tableEnd === -1) tableEnd = log.length;
              log = log.slice(0, tableEnd) + "\n" + entry + log.slice(tableEnd);
              added++;
            }
          }
        }

        if (added > 0) {
          await githubPutFile(capacityPath, log);
          console.log(`📋 Logged ${added} capacity event${added > 1 ? "s" : ""} to Capacity Log (GitHub)`);
        }
      }
    } catch (err: any) {
      console.error(`⚠ Could not update Capacity Log (GitHub): ${err.message}`);
    }
  } else {
    // Local: write to filesystem
    try {
      const obsidianFile = path.join(OBSIDIAN_PATH, `${todayStr}.md`);
      if (!fs.existsSync(OBSIDIAN_PATH)) {
        fs.mkdirSync(OBSIDIAN_PATH, { recursive: true });
      }
      fs.writeFileSync(obsidianFile, content);
      console.log(`\n✅ Saved to Obsidian: ${obsidianFile}`);
    } catch (err: any) {
      console.error(`\n❌ Could not save to Obsidian: ${err.message}`);
    }

    // Append ≥60% shifts from past data to Capacity Log
    const CAPACITY_LOG = path.join(os.homedir(), "Obsidian Vaults/Austin's Brain/Hello Sugar/Capacity Log.md");
    try {
      if (fs.existsSync(CAPACITY_LOG)) {
        let log = fs.readFileSync(CAPACITY_LOG, "utf-8");
        let added = 0;
        const locations = ["Bountiful", "Farmington", "Heber City", "Ogden", "Riverton", "Sugar House", "West Valley"];
        const fullDayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

        for (const locName of locations) {
          const loc = locationData.find(l => l.shortName === locName);
          if (!loc) continue;
          for (const d of loc.pastDailyUtil) {
            for (const [label, bucket] of [["8a-2p", d.am], ["2p-8p", d.pm]] as const) {
              const avail = Math.max(0, bucket.scheduledMin - bucket.blockedMin);
              if (bucket.utilization < 60 || avail <= 60) continue;
              const entry = `| ${d.dateStr} | ${label} | ${bucket.utilization}% | ${(avail / 60).toFixed(1)}h | ${(bucket.bookedMin / 60).toFixed(1)}h |`;
              if (log.includes(entry)) continue;
              const locHeading = `## ${locName}`;
              const locIdx = log.indexOf(locHeading);
              if (locIdx === -1) continue;
              const dayHeading = `### ${fullDayNames[new Date(d.dateStr + "T12:00:00-06:00").getDay()]}`;
              const dayIdx = log.indexOf(dayHeading, locIdx);
              if (dayIdx === -1) continue;
              const afterDay = log.indexOf("\n", dayIdx) + 1;
              let tableEnd = log.indexOf("\n\n", afterDay);
              if (tableEnd === -1) tableEnd = log.length;
              log = log.slice(0, tableEnd) + "\n" + entry + log.slice(tableEnd);
              added++;
            }
          }
        }

        if (added > 0) {
          fs.writeFileSync(CAPACITY_LOG, log);
          console.log(`📋 Logged ${added} capacity event${added > 1 ? "s" : ""} to Capacity Log`);
        }
      }
    } catch (err: any) {
      console.error(`⚠ Could not update Capacity Log: ${err.message}`);
    }
  }

  // Post to Pronto (only for live runs, not backfills)
  if (!targetDateStr) {
    try {
      const prontoLines: string[] = [];
      prontoLines.push(`📋 UTAH ACTION ITEMS — ${dayName.toUpperCase()}`);
      prontoLines.push(``);

      // Portfolio snapshot
      prontoLines.push(`📊 PORTFOLIO SNAPSHOT`);
      prontoLines.push(`Yesterday: ${portfolioYesterday} bookings (${formatPercent(velocityDelta)} vs avg), ${newClientsYesterday} new clients`);
      prontoLines.push(`Utilization: ${avgPastUtil}% actual (last 7d) → ${avgFutureUtil}% forecast (next 7d)`);
      if (adData) {
        prontoLines.push(`Ad spend: $${adData.totalSpend.toFixed(0)} → $${adData.overallCPB.toFixed(2)} CPB`);
      }
      prontoLines.push(``);

      // Capacity alerts
      const prontoAlerts: string[] = [];
      for (const loc of locationData) {
        for (const d of loc.futureDailyUtil) {
          for (const [label, bucket] of [["8a-2p", d.am], ["2p-8p", d.pm]] as const) {
            const avail = Math.max(0, bucket.scheduledMin - bucket.blockedMin);
            if (bucket.utilization >= 75 && avail > 60) {
              prontoAlerts.push(`   → ${loc.shortName.toUpperCase()} ${d.dayName} ${d.dateStr.slice(5)} ${label} — ${bucket.utilization}% booked`);
            }
          }
        }
      }
      if (prontoAlerts.length > 0) {
        prontoLines.push(`🚨 CAPACITY — Add coverage or open waitlist:`);
        prontoLines.push(...prontoAlerts);
        prontoLines.push(``);
      }

      // Ad alerts
      if (adData && adData.alerts.length > 0) {
        prontoLines.push(`💰 ADS — Review campaigns:`);
        for (const alert of adData.alerts) {
          prontoLines.push(`   → ${alert}`);
        }
        prontoLines.push(`     ACTION: Check targeting, pause underperformers`);
        prontoLines.push(``);
      }

      // Retention
      if (retentionForPronto.length > 0) {
        prontoLines.push(`💔 RETENTION — Win back these clients:`);
        prontoLines.push(``);
        for (const r of retentionForPronto) {
          const clientUrl = r.clientId ? `https://dashboard.boulevard.io/clients/${r.clientId}` : null;
          prontoLines.push(`   ${r.client.toUpperCase()} (${r.location}) — $${r.ltv.toLocaleString()} LTV | Tier ${r.offer.tier}`);
          if (clientUrl) prontoLines.push(`   🔗 ${clientUrl}`);
          prontoLines.push(`   📧 ${r.email}`);
          prontoLines.push(`   Cancelled: ${r.churnDate} | Last visit: ${r.lastAppt}`);
          prontoLines.push(`   Reason: ${r.reason}`);
          prontoLines.push(`   OFFER ONE:`);
          for (const opt of r.offer.options.slice(0, 3)) {
            prontoLines.push(`      • ${opt}`);
          }
          prontoLines.push(``);
        }
      }

      const prontoMessage = prontoLines.join("\n").trim();
      if (prontoMessage) {
        await postToPronto(prontoMessage);
        console.log(`📱 Posted to Pronto (Utah chat)`);
      }
    } catch (err: any) {
      console.error(`⚠ Could not post to Pronto: ${err.message}`);
    }
  }
}

// Accept date argument: npx tsx scripts/daily-brief-v4.ts 2026-03-15
const dateArg = process.argv[2];
generateBrief(dateArg).catch(console.error);

import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({
  projectId: "even-affinity-388602",
});

const DATASET = "snowflake_data";

// Map short names to BQ location names
const LOCATION_NAME_MAP: Record<string, string> = {
  "Bountiful": "UT Bountiful | Colonial Square 042",
  "Farmington": "UT Farmington | Farmington Station 227",
  "Heber City": "UT Heber City | Valley Station 236",
  "Ogden": "UT Ogden | Riverdale 082",
  "Riverton": "UT Riverton | Mountain View Village 237",
  "Sugar House": "UT Salt Lake City | Sugar House 126",
  "West Valley": "UT West Valley | Valley Fair 176",
  // Acquisition targets
  "American Fork": "UT American Fork | Meadows 065",
  "Draper": "UT Draper | Draper Peaks 103",
  "Midvale": "UT Midvale | Fort Union 043",
  "Spanish Fork": "UT Spanish Fork | Central 192",
};

export interface AdPerformance {
  shortName: string;
  google: {
    spend: number;
    brandSpend: number;
    nonBrandSpend: number;
    bookings: number;
    newBookings: number;
    returningBookings: number;
    costPerBooking: number;
  };
  meta: {
    spend: number;
    leads: number;
    bookings: number;
    newBookings: number;
    returningBookings: number;
    costPerBooking: number;
  };
  totalSpend: number;
  totalBookings: number;
  totalCostPerBooking: number;
  // Week over week comparison
  priorWeekCPB: number | null;
  cpbChange: number | null;
}

export interface PortfolioAdSummary {
  totalGoogleSpend: number;
  totalMetaSpend: number;
  totalSpend: number;
  totalGoogleBookings: number;
  totalMetaBookings: number;
  totalBookings: number;
  googleCPB: number;
  metaCPB: number;
  overallCPB: number;
  locations: AdPerformance[];
  alerts: string[];
}

export async function getAdPerformance(
  shortNames: string[],
  daysBack: number = 7
): Promise<PortfolioAdSummary> {
  const locations: AdPerformance[] = [];
  const alerts: string[] = [];

  for (const shortName of shortNames) {
    const bqName = LOCATION_NAME_MAP[shortName];
    if (!bqName) continue;

    try {
      // Google Ads - current period
      const [googleRows] = await bigquery.query({
        query: `
          SELECT
            ROUND(SUM(CAST(_COL_2 AS FLOAT64)), 2) as total_spend,
            ROUND(SUM(CAST(_COL_4 AS FLOAT64)), 2) as brand_spend,
            ROUND(SUM(CAST(_COL_6 AS FLOAT64)), 2) as non_brand_spend,
            ROUND(SUM(CAST(_COL_10 AS FLOAT64)), 0) as new_bookings,
            ROUND(SUM(CAST(_COL_11 AS FLOAT64)), 0) as returning_bookings,
            ROUND(SUM(CAST(_COL_12 AS FLOAT64)), 0) as total_bookings
          FROM \`${DATASET}.tbl_ga_lp_booking_with_spend\`
          WHERE _COL_1 = @location
            AND _COL_0 >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
        `,
        params: { location: bqName, days: daysBack },
      });

      // Google Ads - prior period for comparison
      const [googlePriorRows] = await bigquery.query({
        query: `
          SELECT
            ROUND(SUM(CAST(_COL_2 AS FLOAT64)), 2) as total_spend,
            ROUND(SUM(CAST(_COL_12 AS FLOAT64)), 0) as total_bookings
          FROM \`${DATASET}.tbl_ga_lp_booking_with_spend\`
          WHERE _COL_1 = @location
            AND _COL_0 >= DATE_SUB(CURRENT_DATE(), INTERVAL @startDays DAY)
            AND _COL_0 < DATE_SUB(CURRENT_DATE(), INTERVAL @endDays DAY)
        `,
        params: { location: bqName, startDays: daysBack * 2, endDays: daysBack },
      });

      // Meta Ads - current period
      const [metaRows] = await bigquery.query({
        query: `
          SELECT
            ROUND(SUM(CAST(_COL_2 AS FLOAT64)), 2) as total_spend,
            ROUND(SUM(CAST(_COL_3 AS FLOAT64)), 0) as leads,
            ROUND(SUM(CAST(_COL_4 AS FLOAT64)), 0) as new_bookings,
            ROUND(SUM(CAST(_COL_5 AS FLOAT64)), 0) as returning_bookings
          FROM \`${DATASET}.tbl_meta_booking_lp_with_spend\`
          WHERE _COL_1 = @location
            AND _COL_0 >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
        `,
        params: { location: bqName, days: daysBack },
      });

      const google = googleRows[0] || {};
      const googlePrior = googlePriorRows[0] || {};
      const meta = metaRows[0] || {};

      const googleSpend = Number(google.total_spend) || 0;
      const googleBookings = Number(google.total_bookings) || 0;
      const googleCPB = googleBookings > 0 ? googleSpend / googleBookings : 0;

      const metaSpend = Number(meta.total_spend) || 0;
      const metaBookings = (Number(meta.new_bookings) || 0) + (Number(meta.returning_bookings) || 0);
      const metaCPB = metaBookings > 0 ? metaSpend / metaBookings : 0;

      const priorSpend = Number(googlePrior.total_spend) || 0;
      const priorBookings = Number(googlePrior.total_bookings) || 0;
      const priorCPB = priorBookings > 0 ? priorSpend / priorBookings : null;

      const cpbChange = priorCPB && googleCPB ? ((googleCPB - priorCPB) / priorCPB) * 100 : null;

      // Generate alerts
      if (cpbChange && cpbChange > 30) {
        alerts.push(`${shortName} Google CPB up ${Math.round(cpbChange)}% vs prior week ($${priorCPB?.toFixed(2)} → $${googleCPB.toFixed(2)})`);
      }
      if (metaSpend < 1 && googleSpend > 100) {
        alerts.push(`${shortName} Meta spend near zero ($${metaSpend.toFixed(2)})`);
      }

      locations.push({
        shortName,
        google: {
          spend: googleSpend,
          brandSpend: Number(google.brand_spend) || 0,
          nonBrandSpend: Number(google.non_brand_spend) || 0,
          bookings: googleBookings,
          newBookings: Number(google.new_bookings) || 0,
          returningBookings: Number(google.returning_bookings) || 0,
          costPerBooking: googleCPB,
        },
        meta: {
          spend: metaSpend,
          leads: Number(meta.leads) || 0,
          bookings: metaBookings,
          newBookings: Number(meta.new_bookings) || 0,
          returningBookings: Number(meta.returning_bookings) || 0,
          costPerBooking: metaCPB,
        },
        totalSpend: googleSpend + metaSpend,
        totalBookings: googleBookings + metaBookings,
        totalCostPerBooking: (googleBookings + metaBookings) > 0
          ? (googleSpend + metaSpend) / (googleBookings + metaBookings)
          : 0,
        priorWeekCPB: priorCPB,
        cpbChange,
      });
    } catch (err) {
      console.error(`Error fetching ad data for ${shortName}:`, err);
    }
  }

  // Calculate portfolio totals
  const totalGoogleSpend = locations.reduce((sum, l) => sum + l.google.spend, 0);
  const totalMetaSpend = locations.reduce((sum, l) => sum + l.meta.spend, 0);
  const totalGoogleBookings = locations.reduce((sum, l) => sum + l.google.bookings, 0);
  const totalMetaBookings = locations.reduce((sum, l) => sum + l.meta.bookings, 0);

  // Check for portfolio-wide meta issue
  if (totalMetaSpend < 10 && totalGoogleSpend > 500) {
    alerts.unshift(`Portfolio Meta spend near zero ($${totalMetaSpend.toFixed(2)}) — is this intentional?`);
  }

  return {
    totalGoogleSpend,
    totalMetaSpend,
    totalSpend: totalGoogleSpend + totalMetaSpend,
    totalGoogleBookings,
    totalMetaBookings,
    totalBookings: totalGoogleBookings + totalMetaBookings,
    googleCPB: totalGoogleBookings > 0 ? totalGoogleSpend / totalGoogleBookings : 0,
    metaCPB: totalMetaBookings > 0 ? totalMetaSpend / totalMetaBookings : 0,
    overallCPB: (totalGoogleBookings + totalMetaBookings) > 0
      ? (totalGoogleSpend + totalMetaSpend) / (totalGoogleBookings + totalMetaBookings)
      : 0,
    locations,
    alerts,
  };
}

import "dotenv/config";
import { GraphQLClient, gql } from "graphql-request";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
  return `Basic ${Buffer.from(`${apiKey}:${token}`, "utf8").toString("base64")}`;
}

const client = new GraphQLClient(BLVD_API_URL, {
  headers: { Authorization: generateAuthHeader() }
});

const toUrn = (id: string) => id.startsWith("urn:") ? id : `urn:blvd:Staff:${id}`;
const toUuid = (id: string) => id.replace(/^urn:blvd:Staff:/, "");

// Load location config
const configPath = path.join(__dirname, "../config/utah-locations.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Global staff map
let globalStaffMap: Map<string, { name: string; displayName: string; role: string }> | null = null;

async function loadStaffMap(): Promise<Map<string, { name: string; displayName: string; role: string }>> {
  if (globalStaffMap) return globalStaffMap;

  const staffQuery = gql`
    query GetStaff($first: Int!, $after: String) {
      staff(first: $first, after: $after) {
        edges { node { id name displayName role { name } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  globalStaffMap = new Map();
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const result = await client.request<any>(staffQuery, { first: 100, after: cursor });
    for (const edge of result.staff.edges) {
      const uuid = toUuid(edge.node.id);
      globalStaffMap.set(uuid, {
        name: edge.node.name,
        displayName: edge.node.displayName || edge.node.name,
        role: edge.node.role?.name || "Unknown"
      });
    }
    hasMore = result.staff.pageInfo.hasNextPage;
    cursor = result.staff.pageInfo.endCursor;
    if (hasMore) await new Promise(r => setTimeout(r, 200));
  }

  return globalStaffMap;
}

interface StaffData {
  id: string;
  name: string;
  displayName: string;
  role: string;
  shifts: {
    dayOfWeek: string;
    clockIn: string;
    clockOut: string;
    hoursPerWeek: number;
  }[];
  metrics: {
    appointmentsNext2Weeks: number;
    utilizationByDay: { day: string; bucket: string; utilization: number; bookedMinutes: number; availableMinutes: number }[];
    averageUtilization: number;
    peakDay: string | null;
    peakUtilization: number;
  };
  btbStatus: {
    hasStartBTB: boolean;
    hasEndBTB: boolean;
    recommendations: string[];
  }[];
}

interface ServiceData {
  name: string;
  category: string;
  count: number;
  percentOfTotal: number;
  averageDuration: number;
}

interface DailyBookingData {
  date: string;
  dayOfWeek: string;
  totalBookings: number;
  newClients: number;
  returningClients: number;
}

interface LocationExport {
  id: string;
  name: string;
  shortName: string;
  city: string;

  // Summary metrics
  summary: {
    totalStaff: number;
    activeStaff: number;
    totalAppointmentsNext2Weeks: number;
    averageUtilization: number;
    capacityAlertCount: number;
    growthBottleneckCount: number;
    underutilizedShiftCount: number;
  };

  // Booking velocity
  bookingVelocity: {
    last7Days: DailyBookingData[];
    yesterdayTotal: number;
    dailyAverage: number;
    velocityTrend: number; // percentage change
    newClientsYesterday: number;
    newClientsWeekTotal: number;
  };

  // Staff breakdown
  staff: StaffData[];

  // Service mix
  services: {
    last2Weeks: ServiceData[];
    topService: string;
    categoryBreakdown: { category: string; count: number; percent: number }[];
  };

  // Shift utilization detail
  shiftUtilization: {
    byDayAndBucket: {
      day: string;
      bucket: string;
      totalAvailableMinutes: number;
      totalBookedMinutes: number;
      utilization: number;
      staffCount: number;
    }[];
    capacityAlerts: { staff: string; day: string; bucket: string; utilization: number }[];
    growthBottlenecks: { staff: string; day: string; bucket: string; utilization: number }[];
    underutilized: { staff: string; day: string; bucket: string; utilization: number }[];
  };

  // BTB analysis
  btbAnalysis: {
    currentBTBBlocks: { staff: string; date: string; startTime: string; endTime: string; position: string }[];
    removalRecommendations: { staff: string; date: string; position: string; reason: string }[];
    additionRecommendations: { staff: string; date: string; position: string; reason: string }[];
  };

  // Raw appointment data (last 2 weeks)
  recentAppointments: {
    id: string;
    date: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    duration: number;
    staff: string;
    services: string[];
    isNewClient: boolean;
    state: string;
  }[];
}

interface PortfolioExport {
  exportedAt: string;
  exportVersion: string;
  dateRange: {
    analysisStart: string;
    analysisEnd: string;
    bookingVelocityStart: string;
  };

  // Portfolio summary
  portfolioSummary: {
    totalLocations: number;
    totalStaff: number;
    totalAppointmentsNext2Weeks: number;
    averageUtilization: number;
    bookingsYesterday: number;
    bookings7DayAvg: number;
    velocityTrend: number;
    newClientsYesterday: number;
    newClientsWeekTotal: number;
    capacityAlertCount: number;
    growthBottleneckCount: number;
  };

  // Location rankings
  rankings: {
    byUtilization: { location: string; utilization: number; rank: number }[];
    byBookingVelocity: { location: string; velocityTrend: number; rank: number }[];
    byNewClients: { location: string; newClients: number; rank: number }[];
  };

  // Owned locations
  ownedLocations: LocationExport[];

  // Acquisition targets (lighter data)
  acquisitionTargets: {
    id: string;
    name: string;
    shortName: string;
    city: string;
    summary: {
      totalStaff: number;
      averageUtilization: number;
      dailyBookingAverage: number;
    };
  }[];

  // AI analysis prompts (suggestions for agent team)
  analysisPrompts: string[];
}

async function getBookingVelocityData(locationId: string, daysBack: number = 7): Promise<{
  dailyData: DailyBookingData[];
  yesterdayTotal: number;
  dailyAverage: number;
  velocityTrend: number;
  newClientsYesterday: number;
  newClientsWeekTotal: number;
}> {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - daysBack);
  const startDateStr = startDate.toISOString().split("T")[0];

  try {
    const appointments = await getAppointmentsByCreatedDate(locationId, startDateStr, yesterdayStr, 2000);

    // Group by date
    const byDate = new Map<string, { total: number; newClients: number; returning: number }>();

    for (let d = new Date(startDate); d <= yesterday; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split("T")[0];
      byDate.set(dateStr, { total: 0, newClients: 0, returning: 0 });
    }

    for (const apt of appointments) {
      if (!apt.createdAt) continue;
      const createdDate = apt.createdAt.split("T")[0];
      const entry = byDate.get(createdDate);
      if (!entry) continue;

      entry.total++;

      // Check if new client
      if (apt.client?.createdAt) {
        const clientCreated = apt.client.createdAt.split("T")[0];
        if (clientCreated === createdDate) {
          entry.newClients++;
        } else {
          entry.returning++;
        }
      }
    }

    const dailyData: DailyBookingData[] = [];
    for (const [date, data] of byDate) {
      const d = new Date(date + "T12:00:00");
      dailyData.push({
        date,
        dayOfWeek: dayNames[d.getDay()],
        totalBookings: data.total,
        newClients: data.newClients,
        returningClients: data.returning
      });
    }

    const yesterdayData = byDate.get(yesterdayStr) || { total: 0, newClients: 0 };
    const totalBookings = [...byDate.values()].reduce((sum, d) => sum + d.total, 0);
    const dailyAverage = Math.round(totalBookings / daysBack);
    const velocityTrend = dailyAverage > 0 ? Math.round((yesterdayData.total / dailyAverage - 1) * 100) : 0;
    const newClientsWeekTotal = [...byDate.values()].reduce((sum, d) => sum + d.newClients, 0);

    return {
      dailyData,
      yesterdayTotal: yesterdayData.total,
      dailyAverage,
      velocityTrend,
      newClientsYesterday: yesterdayData.newClients,
      newClientsWeekTotal
    };
  } catch {
    return {
      dailyData: [],
      yesterdayTotal: 0,
      dailyAverage: 0,
      velocityTrend: 0,
      newClientsYesterday: 0,
      newClientsWeekTotal: 0
    };
  }
}

async function getServiceData(locationId: string): Promise<{
  services: ServiceData[];
  categoryBreakdown: { category: string; count: number; percent: number }[];
}> {
  const apptsQuery = gql`
    query GetAppointments($locationId: ID!, $first: Int!, $after: String) {
      appointments(locationId: $locationId, first: $first, after: $after) {
        edges {
          node {
            startAt cancelled state
            appointmentServices {
              service { name category { name } }
              duration
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const serviceMap = new Map<string, { name: string; category: string; count: number; totalDuration: number }>();
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const cutoffStr = twoWeeksAgo.toISOString();

  let cursor: string | null = null;
  let hasMore = true;
  let pages = 0;

  while (hasMore && pages < 15) {
    if (pages > 0) await new Promise(r => setTimeout(r, 300));

    try {
      const result = await client.request<any>(apptsQuery, { locationId, first: 100, after: cursor });

      for (const edge of result.appointments.edges) {
        const apt = edge.node;
        if (apt.cancelled || apt.state !== "FINAL") continue;
        if (apt.startAt < cutoffStr) continue;

        for (const svc of apt.appointmentServices || []) {
          if (!svc.service?.name) continue;
          const name = svc.service.name;
          const category = svc.service.category?.name || "Uncategorized";
          const existing = serviceMap.get(name);

          if (existing) {
            existing.count++;
            existing.totalDuration += svc.duration || 0;
          } else {
            serviceMap.set(name, { name, category, count: 1, totalDuration: svc.duration || 0 });
          }
        }
      }

      hasMore = result.appointments.pageInfo.hasNextPage;
      cursor = result.appointments.pageInfo.endCursor;
      pages++;
    } catch {
      break;
    }
  }

  const totalServices = [...serviceMap.values()].reduce((sum, s) => sum + s.count, 0);
  const services: ServiceData[] = [...serviceMap.values()]
    .sort((a, b) => b.count - a.count)
    .map(s => ({
      name: s.name,
      category: s.category,
      count: s.count,
      percentOfTotal: totalServices > 0 ? Math.round((s.count / totalServices) * 1000) / 10 : 0,
      averageDuration: s.count > 0 ? Math.round(s.totalDuration / s.count) : 0
    }));

  // Category breakdown
  const categoryMap = new Map<string, number>();
  for (const s of serviceMap.values()) {
    categoryMap.set(s.category, (categoryMap.get(s.category) || 0) + s.count);
  }

  const categoryBreakdown = [...categoryMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      count,
      percent: totalServices > 0 ? Math.round((count / totalServices) * 1000) / 10 : 0
    }));

  return { services, categoryBreakdown };
}

async function exportLocation(location: any, staffMap: Map<string, any>): Promise<LocationExport> {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const twoWeeksOut = new Date(today);
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  const twoWeeksOutStr = twoWeeksOut.toISOString().split("T")[0];

  // Get shifts
  const shiftsQuery = gql`
    query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
      shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
        shifts { staffId day clockIn clockOut available recurrenceStart recurrenceEnd }
      }
    }
  `;

  const shiftsData = await client.request<any>(shiftsQuery, {
    locationId: location.id,
    startIso8601: todayStr,
    endIso8601: twoWeeksOutStr
  });

  // Get appointments
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

  const allAppts: any[] = [];
  let apptCursor: string | null = null;
  let hasMoreAppts = true;
  let pageCount = 0;

  while (hasMoreAppts && pageCount < 25) {
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

  // Fetch timeblocks for accurate utilization (exclude lunch/DNB, keep BTB as bookable)
  let allTimeblocks: Timeblock[] = [];
  try {
    allTimeblocks = await getTimeblocks(location.id);
  } catch {
    // Continue without timeblocks if fetch fails
  }

  // Get booking velocity
  const velocityData = await getBookingVelocityData(location.id, 7);

  // Get service data
  const serviceData = await getServiceData(location.id);

  // Calculate utilization by staff, day, bucket
  const AM_START = 8, AM_END = 14, PM_START = 14, PM_END = 20;

  interface BucketData {
    staffId: string;
    staffName: string;
    day: number;
    bucket: string;
    availMin: number;
    bookedMin: number;
    blockedMin: number;
  }

  const bucketData = new Map<string, BucketData>();
  const staffShiftMap = new Map<string, Set<string>>(); // staffId -> set of "day|clockIn|clockOut"

  for (const shift of shiftsData.shifts.shifts) {
    if (!shift.staffId || !shift.available) continue;
    const staffInfo = staffMap.get(shift.staffId);
    const staffName = staffInfo?.displayName || "Unknown";
    if (staffName.toLowerCase().includes("training")) continue;

    // Track unique shifts per staff
    if (!staffShiftMap.has(shift.staffId)) {
      staffShiftMap.set(shift.staffId, new Set());
    }
    staffShiftMap.get(shift.staffId)!.add(`${shift.day}|${shift.clockIn}|${shift.clockOut}`);

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

            // Calculate blocked time (lunch, DNB — but NOT BTB which stays bookable)
            let blockedMin = 0;
            for (const tb of allTimeblocks) {
              const title = (tb.title || "").toLowerCase();
              if (title.includes("btb") || title.includes("b2b")) continue; // BTB stays bookable

              const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
              if (tbStaffId !== shift.staffId) continue;

              const tbStart = new Date(tb.startAt).getTime();
              const tbEnd = new Date(tb.endAt).getTime();

              if (tbStart < bucketEnd.getTime() && tbEnd > bucketStart.getTime()) {
                const overlapStart = Math.max(tbStart, bucketStart.getTime());
                const overlapEnd = Math.min(tbEnd, bucketEnd.getTime());
                blockedMin += (overlapEnd - overlapStart) / 60000;
              }
            }

            const key = `${shift.staffId}|${shift.day}|${bucket}`;
            if (!bucketData.has(key)) {
              bucketData.set(key, { staffId: shift.staffId, staffName, day: shift.day, bucket, availMin: 0, bookedMin: 0, blockedMin: 0 });
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

  // Build staff data
  const staffDataMap = new Map<string, StaffData>();

  for (const [key, data] of bucketData) {
    const effectiveAvail = Math.max(data.availMin - data.blockedMin, 0);
    const util = effectiveAvail > 0 ? Math.round((data.bookedMin / effectiveAvail) * 100) : 0;

    if (!staffDataMap.has(data.staffId)) {
      const staffInfo = staffMap.get(data.staffId);
      const shifts = staffShiftMap.get(data.staffId) || new Set();
      const shiftDetails = [...shifts].map(s => {
        const [day, clockIn, clockOut] = s.split("|");
        const [h1, m1] = clockIn.split(":").map(Number);
        const [h2, m2] = clockOut.split(":").map(Number);
        const hours = (h2 + m2/60) - (h1 + m1/60);
        return {
          dayOfWeek: dayNames[parseInt(day)],
          clockIn,
          clockOut,
          hoursPerWeek: Math.round(hours * 10) / 10
        };
      });

      staffDataMap.set(data.staffId, {
        id: data.staffId,
        name: staffInfo?.name || "Unknown",
        displayName: staffInfo?.displayName || "Unknown",
        role: staffInfo?.role || "Unknown",
        shifts: shiftDetails,
        metrics: {
          appointmentsNext2Weeks: 0,
          utilizationByDay: [],
          averageUtilization: 0,
          peakDay: null,
          peakUtilization: 0
        },
        btbStatus: []
      });
    }

    const staffData = staffDataMap.get(data.staffId)!;
    staffData.metrics.utilizationByDay.push({
      day: dayNames[data.day],
      bucket: data.bucket === "AM" ? "8AM-2PM" : "2PM-8PM",
      utilization: util,
      bookedMinutes: Math.round(data.bookedMin),
      availableMinutes: Math.round(data.availMin)
    });
  }

  // Calculate staff averages and peaks
  for (const staffData of staffDataMap.values()) {
    const utils = staffData.metrics.utilizationByDay;
    if (utils.length > 0) {
      staffData.metrics.averageUtilization = Math.round(
        utils.reduce((sum, u) => sum + u.utilization, 0) / utils.length
      );
      const peak = utils.reduce((max, u) => u.utilization > max.utilization ? u : max, utils[0]);
      staffData.metrics.peakDay = `${peak.day} ${peak.bucket}`;
      staffData.metrics.peakUtilization = peak.utilization;
    }

    // Count appointments for this staff
    const staffUrn = toUrn(staffData.id);
    staffData.metrics.appointmentsNext2Weeks = periodAppts.filter((a: any) =>
      a.appointmentServices?.some((svc: any) => svc.staff?.id === staffUrn)
    ).length;
  }

  // Build shift utilization summary
  const dayBucketSummary = new Map<string, { availMin: number; bookedMin: number; blockedMin: number; staffIds: Set<string> }>();

  for (const [_, data] of bucketData) {
    const key = `${data.day}|${data.bucket}`;
    if (!dayBucketSummary.has(key)) {
      dayBucketSummary.set(key, { availMin: 0, bookedMin: 0, blockedMin: 0, staffIds: new Set() });
    }
    const summary = dayBucketSummary.get(key)!;
    summary.availMin += data.availMin;
    summary.bookedMin += data.bookedMin;
    summary.blockedMin += data.blockedMin;
    summary.staffIds.add(data.staffId);
  }

  const byDayAndBucket = [...dayBucketSummary.entries()].map(([key, summary]) => {
    const [day, bucket] = key.split("|");
    const effectiveAvail = Math.max(summary.availMin - summary.blockedMin, 0);
    return {
      day: dayNames[parseInt(day)],
      bucket: bucket === "AM" ? "8AM-2PM" : "2PM-8PM",
      totalAvailableMinutes: Math.round(effectiveAvail),
      totalBookedMinutes: Math.round(summary.bookedMin),
      utilization: effectiveAvail > 0 ? Math.round((summary.bookedMin / effectiveAvail) * 100) : 0,
      staffCount: summary.staffIds.size
    };
  }).sort((a, b) => {
    const dayOrder = dayNames.indexOf(a.day) - dayNames.indexOf(b.day);
    if (dayOrder !== 0) return dayOrder;
    return a.bucket.localeCompare(b.bucket);
  });

  // Categorize shifts
  const capacityAlerts: { staff: string; day: string; bucket: string; utilization: number }[] = [];
  const growthBottlenecks: { staff: string; day: string; bucket: string; utilization: number }[] = [];
  const underutilized: { staff: string; day: string; bucket: string; utilization: number }[] = [];

  for (const [_, data] of bucketData) {
    const effectiveAvail = Math.max(data.availMin - data.blockedMin, 0);
    const util = effectiveAvail > 0 ? Math.round((data.bookedMin / effectiveAvail) * 100) : 0;
    const entry = {
      staff: data.staffName,
      day: dayNames[data.day],
      bucket: data.bucket === "AM" ? "8AM-2PM" : "2PM-8PM",
      utilization: util
    };

    if (util >= 75) {
      capacityAlerts.push(entry);
    } else if (util >= 50) {
      growthBottlenecks.push(entry);
    } else if (util < 20) {
      underutilized.push(entry);
    }
  }

  // BTB Analysis
  let btbAnalysis = {
    currentBTBBlocks: [] as any[],
    removalRecommendations: [] as any[],
    additionRecommendations: [] as any[]
  };

  try {
    const btbEndDate = new Date(today);
    btbEndDate.setDate(btbEndDate.getDate() + 7);
    const shifts = await getShifts(location.id, todayStr, btbEndDate.toISOString().split("T")[0]);
    const timeblocks = await getTimeblocks(location.id);

    // Current BTB blocks
    const twoWeeksFromNow = new Date(today);
    twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);

    for (const tb of timeblocks) {
      const title = tb.title?.toLowerCase() || "";
      if (!title.includes("btb") && !title.includes("b2b")) continue;
      const tbDate = new Date(tb.startAt);
      if (tbDate < today || tbDate > twoWeeksFromNow) continue;

      btbAnalysis.currentBTBBlocks.push({
        staff: tb.staff?.name || "Unknown",
        date: tb.startAt.split("T")[0],
        startTime: tb.startAt,
        endTime: tb.endAt,
        position: "unknown"
      });
    }

    // Analyze each shift
    const seenRecommendations = new Set<string>();

    for (const shift of shifts) {
      const staffName = shift.staffMember.displayName || shift.staffMember.name;
      if (staffName.toLowerCase().includes("training")) continue;

      const analysis = analyzeBTBBlocks(shift, periodAppts as Appointment[], timeblocks, DEFAULT_BTB_CONFIG);

      if (analysis.startBlockShouldRemove && analysis.startBlock) {
        const key = `remove|${staffName}|${shift.date}|start`;
        if (!seenRecommendations.has(key)) {
          seenRecommendations.add(key);
          btbAnalysis.removalRecommendations.push({
            staff: staffName,
            date: shift.date,
            position: "start",
            reason: `${analysis.startGapMinutes}min to first appointment`
          });
        }
      }

      if (analysis.endBlockShouldRemove && analysis.endBlock) {
        const key = `remove|${staffName}|${shift.date}|end`;
        if (!seenRecommendations.has(key)) {
          seenRecommendations.add(key);
          btbAnalysis.removalRecommendations.push({
            staff: staffName,
            date: shift.date,
            position: "end",
            reason: `${analysis.endGapMinutes}min after last appointment`
          });
        }
      }

      if (analysis.startBlockShouldAdd || analysis.startAutoAdd) {
        const key = `add|${staffName}|${shift.date}|start`;
        if (!seenRecommendations.has(key)) {
          seenRecommendations.add(key);
          const gapMin = analysis.minutesToFirstAppointment;
          btbAnalysis.additionRecommendations.push({
            staff: staffName,
            date: shift.date,
            position: "start",
            reason: gapMin !== undefined ? `${gapMin}min gap at shift start` : "no appointments scheduled"
          });
        }
      }

      if (analysis.endBlockShouldAdd || analysis.endAutoAdd) {
        const key = `add|${staffName}|${shift.date}|end`;
        if (!seenRecommendations.has(key)) {
          seenRecommendations.add(key);
          const gapMin = analysis.minutesAfterLastAppointment;
          btbAnalysis.additionRecommendations.push({
            staff: staffName,
            date: shift.date,
            position: "end",
            reason: gapMin !== undefined ? `${gapMin}min gap at shift end` : "no appointments scheduled"
          });
        }
      }
    }
  } catch {
    // BTB analysis failed
  }

  // Recent appointments detail
  const recentAppointments = periodAppts.slice(0, 100).map((apt: any) => {
    const aptDate = new Date(apt.startAt);
    const isNewClient = apt.client?.createdAt &&
      apt.client.createdAt.split("T")[0] === apt.createdAt?.split("T")[0];

    return {
      id: apt.id,
      date: apt.startAt.split("T")[0],
      dayOfWeek: dayNames[aptDate.getDay()],
      startTime: apt.startAt,
      endTime: apt.endAt,
      duration: apt.duration,
      staff: apt.appointmentServices?.[0]?.staff?.name || "Unknown",
      services: (apt.appointmentServices || []).map((s: any) => s.service?.name).filter(Boolean),
      isNewClient: !!isNewClient,
      state: apt.state
    };
  });

  // Build summary (utilization = booked / (available - blocked))
  const totalBlockedMin = [...bucketData.values()].reduce((sum, d) => sum + d.blockedMin, 0);
  const totalAvailMin = [...bucketData.values()].reduce((sum, d) => sum + d.availMin, 0) - totalBlockedMin;
  const totalBookedMin = [...bucketData.values()].reduce((sum, d) => sum + d.bookedMin, 0);
  const avgUtilization = totalAvailMin > 0 ? Math.round((totalBookedMin / totalAvailMin) * 100) : 0;

  return {
    id: location.id,
    name: location.name,
    shortName: location.shortName,
    city: location.city,

    summary: {
      totalStaff: staffDataMap.size,
      activeStaff: [...staffDataMap.values()].filter(s => s.metrics.appointmentsNext2Weeks > 0).length,
      totalAppointmentsNext2Weeks: periodAppts.length,
      averageUtilization: avgUtilization,
      capacityAlertCount: capacityAlerts.length,
      growthBottleneckCount: growthBottlenecks.length,
      underutilizedShiftCount: underutilized.length
    },

    bookingVelocity: {
      last7Days: velocityData.dailyData,
      yesterdayTotal: velocityData.yesterdayTotal,
      dailyAverage: velocityData.dailyAverage,
      velocityTrend: velocityData.velocityTrend,
      newClientsYesterday: velocityData.newClientsYesterday,
      newClientsWeekTotal: velocityData.newClientsWeekTotal
    },

    staff: [...staffDataMap.values()],

    services: {
      last2Weeks: serviceData.services.slice(0, 30),
      topService: serviceData.services[0]?.name || "N/A",
      categoryBreakdown: serviceData.categoryBreakdown
    },

    shiftUtilization: {
      byDayAndBucket,
      capacityAlerts: capacityAlerts.sort((a, b) => b.utilization - a.utilization),
      growthBottlenecks: growthBottlenecks.sort((a, b) => b.utilization - a.utilization),
      underutilized: underutilized.sort((a, b) => a.utilization - b.utilization)
    },

    btbAnalysis,

    recentAppointments
  };
}

async function main() {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const twoWeeksOut = new Date(today);
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  console.log("═".repeat(70));
  console.log("📊 HELLO SUGAR UTAH — PORTFOLIO DATA EXPORT");
  console.log(`📅 ${today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`);
  console.log("═".repeat(70));

  console.log("\nLoading staff directory...");
  const staffMap = await loadStaffMap();
  console.log(`✓ Loaded ${staffMap.size} staff members`);

  console.log("\nExporting owned locations...\n");

  const ownedLocations: LocationExport[] = [];

  for (const loc of config.owned) {
    process.stdout.write(`  📍 ${loc.shortName}...`);
    try {
      const data = await exportLocation(loc, staffMap);
      ownedLocations.push(data);
      console.log(` ✓ (${data.summary.averageUtilization}% util, ${data.summary.totalAppointmentsNext2Weeks} appts)`);
    } catch (e: any) {
      console.log(` ✗ (${e.message?.slice(0, 40)})`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\nExporting acquisition targets...\n");

  const acquisitionTargets: any[] = [];

  for (const target of config.acquisitionTargets) {
    process.stdout.write(`  🎯 ${target.shortName}...`);
    try {
      const velocity = await getBookingVelocityData(target.id, 7);

      // Lighter export for targets
      const shiftsQuery = gql`
        query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
          shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
            shifts { staffId available }
          }
        }
      `;
      const shiftsData = await client.request<any>(shiftsQuery, {
        locationId: target.id,
        startIso8601: todayStr,
        endIso8601: twoWeeksOut.toISOString().split("T")[0]
      });

      const uniqueStaff = new Set(shiftsData.shifts.shifts.filter((s: any) => s.staffId && s.available).map((s: any) => s.staffId));

      acquisitionTargets.push({
        id: target.id,
        name: target.name,
        shortName: target.shortName,
        city: target.city,
        summary: {
          totalStaff: uniqueStaff.size,
          averageUtilization: 0, // Would require full analysis
          dailyBookingAverage: velocity.dailyAverage
        }
      });
      console.log(` ✓ (${uniqueStaff.size} staff, ${velocity.dailyAverage}/day bookings)`);
    } catch {
      console.log(` ✗`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Build portfolio summary
  const totalStaff = ownedLocations.reduce((sum, l) => sum + l.summary.totalStaff, 0);
  const totalAppts = ownedLocations.reduce((sum, l) => sum + l.summary.totalAppointmentsNext2Weeks, 0);
  const avgUtil = ownedLocations.length > 0
    ? Math.round(ownedLocations.reduce((sum, l) => sum + l.summary.averageUtilization, 0) / ownedLocations.length)
    : 0;
  const totalYesterday = ownedLocations.reduce((sum, l) => sum + l.bookingVelocity.yesterdayTotal, 0);
  const total7DayAvg = ownedLocations.reduce((sum, l) => sum + l.bookingVelocity.dailyAverage, 0);
  const velocityTrend = total7DayAvg > 0 ? Math.round((totalYesterday / total7DayAvg - 1) * 100) : 0;
  const totalNewClientsYesterday = ownedLocations.reduce((sum, l) => sum + l.bookingVelocity.newClientsYesterday, 0);
  const totalNewClientsWeek = ownedLocations.reduce((sum, l) => sum + l.bookingVelocity.newClientsWeekTotal, 0);
  const totalCapacityAlerts = ownedLocations.reduce((sum, l) => sum + l.summary.capacityAlertCount, 0);
  const totalBottlenecks = ownedLocations.reduce((sum, l) => sum + l.summary.growthBottleneckCount, 0);

  // Rankings
  const byUtilization = ownedLocations
    .map(l => ({ location: l.shortName, utilization: l.summary.averageUtilization }))
    .sort((a, b) => b.utilization - a.utilization)
    .map((l, i) => ({ ...l, rank: i + 1 }));

  const byVelocity = ownedLocations
    .map(l => ({ location: l.shortName, velocityTrend: l.bookingVelocity.velocityTrend }))
    .sort((a, b) => b.velocityTrend - a.velocityTrend)
    .map((l, i) => ({ ...l, rank: i + 1 }));

  const byNewClients = ownedLocations
    .map(l => ({ location: l.shortName, newClients: l.bookingVelocity.newClientsWeekTotal }))
    .sort((a, b) => b.newClients - a.newClients)
    .map((l, i) => ({ ...l, rank: i + 1 }));

  // Analysis prompts for agent team
  const analysisPrompts = [
    "Analyze the correlation between booking velocity trends and utilization across locations. Are high-velocity locations also high-utilization?",
    "Identify patterns in underutilized shifts across all locations. Are there common days/times that consistently underperform?",
    "Compare service mix between top-performing and bottom-performing locations. What services drive higher utilization?",
    "Evaluate the BTB recommendations — which locations have the most optimization opportunities?",
    "Analyze new client acquisition patterns. Which locations are best at attracting new clients, and what might explain this?",
    "Identify staff members who are consistently hitting capacity alerts. Are they candidates for expanded hours or a second hire?",
    "Compare the acquisition targets to owned locations. Which target looks most operationally similar to your best performer?",
    "Look for seasonal or day-of-week patterns in the booking velocity data. Any actionable insights for marketing?",
    "Identify locations with high staff count but low utilization — could staff be reallocated?",
    "Analyze the gap between 'active staff' and 'total staff' per location. What does this indicate about scheduling efficiency?"
  ];

  const exportData: PortfolioExport = {
    exportedAt: today.toISOString(),
    exportVersion: "2.0",
    dateRange: {
      analysisStart: todayStr,
      analysisEnd: twoWeeksOut.toISOString().split("T")[0],
      bookingVelocityStart: sevenDaysAgo.toISOString().split("T")[0]
    },

    portfolioSummary: {
      totalLocations: ownedLocations.length,
      totalStaff,
      totalAppointmentsNext2Weeks: totalAppts,
      averageUtilization: avgUtil,
      bookingsYesterday: totalYesterday,
      bookings7DayAvg: total7DayAvg,
      velocityTrend,
      newClientsYesterday: totalNewClientsYesterday,
      newClientsWeekTotal: totalNewClientsWeek,
      capacityAlertCount: totalCapacityAlerts,
      growthBottleneckCount: totalBottlenecks
    },

    rankings: {
      byUtilization,
      byBookingVelocity: byVelocity,
      byNewClients
    },

    ownedLocations,
    acquisitionTargets,
    analysisPrompts
  };

  // Write JSON export
  const outputPath = path.join(__dirname, "../exports");
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  const jsonPath = path.join(outputPath, `portfolio-export-${todayStr}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`\n✅ JSON export: ${jsonPath}`);

  // Write markdown summary
  const mdPath = path.join(outputPath, `portfolio-brief-${todayStr}.md`);
  const md = generateMarkdownBrief(exportData);
  fs.writeFileSync(mdPath, md);
  console.log(`✅ Markdown brief: ${mdPath}`);

  console.log("\n" + "═".repeat(70));
  console.log("Export complete! Share these files with your agent team.");
  console.log("═".repeat(70) + "\n");
}

function generateMarkdownBrief(data: PortfolioExport): string {
  const lines: string[] = [];

  lines.push("# Hello Sugar Utah — Portfolio Intelligence Brief");
  lines.push("");
  lines.push(`**Generated:** ${new Date(data.exportedAt).toLocaleString("en-US", { timeZone: "America/Denver" })}`);
  lines.push(`**Analysis Period:** ${data.dateRange.analysisStart} to ${data.dateRange.analysisEnd}`);
  lines.push(`**Booking Velocity Period:** Last 7 days (since ${data.dateRange.bookingVelocityStart})`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Locations | ${data.portfolioSummary.totalLocations} |`);
  lines.push(`| Total Staff | ${data.portfolioSummary.totalStaff} |`);
  lines.push(`| Appointments (next 2 wks) | ${data.portfolioSummary.totalAppointmentsNext2Weeks} |`);
  lines.push(`| Average Utilization | ${data.portfolioSummary.averageUtilization}% |`);
  lines.push(`| Yesterday's Bookings | ${data.portfolioSummary.bookingsYesterday} |`);
  lines.push(`| 7-Day Avg Bookings | ${data.portfolioSummary.bookings7DayAvg} |`);
  lines.push(`| Velocity Trend | ${data.portfolioSummary.velocityTrend >= 0 ? "+" : ""}${data.portfolioSummary.velocityTrend}% |`);
  lines.push(`| New Clients (yesterday) | ${data.portfolioSummary.newClientsYesterday} |`);
  lines.push(`| New Clients (week) | ${data.portfolioSummary.newClientsWeekTotal} |`);
  lines.push(`| Capacity Alerts | ${data.portfolioSummary.capacityAlertCount} |`);
  lines.push(`| Growth Bottlenecks | ${data.portfolioSummary.growthBottleneckCount} |`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Location Rankings");
  lines.push("");
  lines.push("### By Utilization");
  lines.push("| Rank | Location | Utilization |");
  lines.push("|------|----------|-------------|");
  for (const r of data.rankings.byUtilization) {
    lines.push(`| ${r.rank} | ${r.location} | ${r.utilization}% |`);
  }
  lines.push("");

  lines.push("### By Booking Velocity (yesterday vs. avg)");
  lines.push("| Rank | Location | Trend |");
  lines.push("|------|----------|-------|");
  for (const r of data.rankings.byBookingVelocity) {
    lines.push(`| ${r.rank} | ${r.location} | ${r.velocityTrend >= 0 ? "+" : ""}${r.velocityTrend}% |`);
  }
  lines.push("");

  lines.push("### By New Client Acquisition (week)");
  lines.push("| Rank | Location | New Clients |");
  lines.push("|------|----------|-------------|");
  for (const r of data.rankings.byNewClients) {
    lines.push(`| ${r.rank} | ${r.location} | ${r.newClients} |`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Location Details");
  lines.push("");

  for (const loc of data.ownedLocations) {
    lines.push(`### ${loc.shortName}`);
    lines.push("");
    lines.push(`**City:** ${loc.city}`);
    lines.push("");
    lines.push("#### Summary");
    lines.push(`- Staff: ${loc.summary.totalStaff} total, ${loc.summary.activeStaff} active`);
    lines.push(`- Appointments (2 wk): ${loc.summary.totalAppointmentsNext2Weeks}`);
    lines.push(`- Utilization: ${loc.summary.averageUtilization}%`);
    lines.push(`- Capacity Alerts: ${loc.summary.capacityAlertCount}`);
    lines.push(`- Growth Bottlenecks: ${loc.summary.growthBottleneckCount}`);
    lines.push(`- Underutilized Shifts: ${loc.summary.underutilizedShiftCount}`);
    lines.push("");

    lines.push("#### Booking Velocity (Last 7 Days)");
    lines.push(`- Yesterday: ${loc.bookingVelocity.yesterdayTotal} bookings`);
    lines.push(`- Daily Average: ${loc.bookingVelocity.dailyAverage}`);
    lines.push(`- Trend: ${loc.bookingVelocity.velocityTrend >= 0 ? "+" : ""}${loc.bookingVelocity.velocityTrend}%`);
    lines.push(`- New Clients (yesterday): ${loc.bookingVelocity.newClientsYesterday}`);
    lines.push(`- New Clients (week): ${loc.bookingVelocity.newClientsWeekTotal}`);
    lines.push("");

    if (loc.services.last2Weeks.length > 0) {
      lines.push("#### Top Services (Last 2 Weeks)");
      for (const svc of loc.services.last2Weeks.slice(0, 5)) {
        lines.push(`- ${svc.name}: ${svc.count}x (${svc.percentOfTotal}%)`);
      }
      lines.push("");
    }

    if (loc.shiftUtilization.capacityAlerts.length > 0) {
      lines.push("#### Capacity Alerts (≥75%)");
      for (const alert of loc.shiftUtilization.capacityAlerts.slice(0, 5)) {
        lines.push(`- ${alert.staff}: ${alert.day} ${alert.bucket} — ${alert.utilization}%`);
      }
      lines.push("");
    }

    if (loc.shiftUtilization.underutilized.length > 0) {
      lines.push("#### Underutilized Shifts (<20%)");
      for (const shift of loc.shiftUtilization.underutilized.slice(0, 5)) {
        lines.push(`- ${shift.staff}: ${shift.day} ${shift.bucket} — ${shift.utilization}%`);
      }
      lines.push("");
    }

    if (loc.btbAnalysis.removalRecommendations.length > 0 || loc.btbAnalysis.additionRecommendations.length > 0) {
      lines.push("#### BTB Recommendations");
      for (const rec of loc.btbAnalysis.removalRecommendations.slice(0, 3)) {
        lines.push(`- REMOVE: ${rec.staff} ${rec.date} ${rec.position} — ${rec.reason}`);
      }
      for (const rec of loc.btbAnalysis.additionRecommendations.slice(0, 3)) {
        lines.push(`- ADD: ${rec.staff} ${rec.date} ${rec.position} — ${rec.reason}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  lines.push("## Acquisition Targets");
  lines.push("");
  lines.push("| Location | City | Staff | Daily Bookings (avg) |");
  lines.push("|----------|------|-------|---------------------|");
  for (const target of data.acquisitionTargets) {
    lines.push(`| ${target.shortName} | ${target.city} | ${target.summary.totalStaff} | ${target.summary.dailyBookingAverage} |`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Analysis Prompts for Agent Team");
  lines.push("");
  lines.push("Use these prompts to guide deeper analysis:");
  lines.push("");
  for (let i = 0; i < data.analysisPrompts.length; i++) {
    lines.push(`${i + 1}. ${data.analysisPrompts[i]}`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Raw Data");
  lines.push("");
  lines.push("The full JSON export contains:");
  lines.push("- Complete staff rosters with shift schedules and individual utilization metrics");
  lines.push("- Day-by-day booking velocity data for trend analysis");
  lines.push("- Full service breakdown with category analysis");
  lines.push("- Detailed BTB block analysis with current blocks and recommendations");
  lines.push("- Recent appointment data with new client flags");
  lines.push("");
  lines.push("See the companion JSON file for full data access.");

  return lines.join("\n");
}

main().catch(console.error);

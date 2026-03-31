import { GraphQLClient, gql } from "graphql-request";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

const BLVD_API_URL =
  process.env.BLVD_API_URL ||
  "https://dashboard.boulevard.io/api/2020-01/admin";

/**
 * Generate Boulevard API authentication header
 * Uses HMAC-SHA256 signing as per Boulevard docs
 */
function generateAuthHeader(): string {
  const apiKey = process.env.BLVD_API_KEY;
  const apiSecret = process.env.BLVD_API_SECRET;
  const businessId = process.env.BLVD_BUSINESS_ID;

  if (!apiKey || !apiSecret || !businessId) {
    throw new Error(
      "Missing Boulevard credentials. Required: BLVD_API_KEY, BLVD_API_SECRET, BLVD_BUSINESS_ID"
    );
  }

  const prefix = "blvd-admin-v1";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${prefix}${businessId}${timestamp}`;

  // HMAC sign the payload
  const rawKey = Buffer.from(apiSecret, "base64");
  const signature = crypto
    .createHmac("sha256", rawKey)
    .update(payload, "utf8")
    .digest("base64");

  // Create token and encode for Basic auth
  const token = `${signature}${payload}`;
  const httpBasicPayload = `${apiKey}:${token}`;
  const httpBasicCredentials = Buffer.from(httpBasicPayload, "utf8").toString(
    "base64"
  );

  return `Basic ${httpBasicCredentials}`;
}

function getClient(): GraphQLClient {
  const authHeader = generateAuthHeader();

  return new GraphQLClient(BLVD_API_URL, {
    headers: {
      Authorization: authHeader,
    },
  });
}

// Types based on Boulevard API
export interface Location {
  id: string;
  name: string;
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  businessHours?: {
    day: string;
    openTime: string;
    closeTime: string;
  }[];
}

export interface StaffMember {
  id: string;
  name: string;
  displayName?: string;
  role?: { name: string };
}

export interface StaffShiftTemplate {
  staffId: string | null;
  locationId: string;
  clockIn: string; // "HH:mm:ss" format
  clockOut: string; // "HH:mm:ss" format
  day: number; // 0=Sunday, 1=Monday, etc.
  available: boolean;
  recurrence: string | null;
  recurrenceStart: string | null;
  recurrenceEnd: string | null;
}

// Computed shift for a specific date
export interface StaffShift {
  staffId: string;
  staffMember: StaffMember;
  locationId: string;
  date: string; // YYYY-MM-DD
  startAt: string; // ISO datetime
  endAt: string; // ISO datetime
}

export interface Appointment {
  id: string;
  startAt: string;
  endAt: string;
  duration: number;
  cancelled: boolean;
  state: string;
  createdAt?: string;
  client?: {
    id: string;
    name?: string;
    createdAt?: string;
    appointmentCount?: number;
  };
  appointmentServices?: {
    service?: { name: string };
    staff?: StaffMember;
    duration: number;
  }[];
}

export interface Timeblock {
  id: string;
  startAt: string;
  endAt: string;
  duration: number;
  title?: string;
  reason?: string;
  cancelled?: boolean;
  staff?: { id: string; name: string };
}

// GraphQL Queries
const LOCATIONS_QUERY = gql`
  query GetLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after) {
      edges {
        node {
          id
          name
          address {
            line1
            city
            state
            zip
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

const STAFF_QUERY = gql`
  query GetStaff($first: Int!, $after: String) {
    staff(first: $first, after: $after) {
      edges {
        node {
          id
          name
          displayName
          firstName
          lastName
          role {
            name
          }
          locations {
            id
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

const SHIFTS_QUERY = gql`
  query GetShifts(
    $locationId: ID!
    $startIso8601: Date!
    $endIso8601: Date!
    $staffIds: [ID!]
  ) {
    shifts(
      locationId: $locationId
      startIso8601: $startIso8601
      endIso8601: $endIso8601
      staffIds: $staffIds
    ) {
      shifts {
        staffId
        locationId
        clockIn
        clockOut
        day
        available
        recurrence
        recurrenceStart
        recurrenceEnd
      }
    }
  }
`;

const APPOINTMENTS_QUERY = gql`
  query GetAppointments($locationId: ID!, $first: Int, $after: String) {
    appointments(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id
          startAt
          endAt
          duration
          cancelled
          state
          createdAt
          client {
            id
            name
            createdAt
          }
          appointmentServices {
            service {
              name
            }
            staff {
              id
              name
            }
            duration
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

const TIMEBLOCKS_QUERY = gql`
  query GetTimeblocks($locationId: ID!, $first: Int, $after: String) {
    timeblocks(locationId: $locationId, first: $first, after: $after) {
      edges {
        node {
          id
          startAt
          endAt
          duration
          title
          reason
          cancelled
          staff {
            id
            name
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

const CREATE_TIMEBLOCK_MUTATION = gql`
  mutation CreateTimeblock($input: CreateTimeblockInput!) {
    createTimeblock(input: $input) {
      timeblock {
        id
        startAt
        endAt
        duration
        title
        reason
        staff {
          id
          name
        }
      }
    }
  }
`;

const DELETE_TIMEBLOCK_MUTATION = gql`
  mutation DeleteTimeblock($input: DeleteTimeblockInput!) {
    deleteTimeblock(input: $input) {
      id
    }
  }
`;

// API Response Types
interface LocationsResponse {
  locations: {
    edges: { node: Location }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// API Functions
export async function getLocations(): Promise<Location[]> {
  const client = getClient();
  const allLocations: Location[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: LocationsResponse = await client.request<LocationsResponse>(
      LOCATIONS_QUERY,
      { first: 100, after: cursor }
    );

    allLocations.push(...data.locations.edges.map((edge: { node: Location }) => edge.node));
    hasNextPage = data.locations.pageInfo.hasNextPage;
    cursor = data.locations.pageInfo.endCursor;
  }

  return allLocations;
}

interface StaffWithLocations extends StaffMember {
  locations?: { id: string }[];
}

interface StaffResponse {
  staff: {
    edges: { node: StaffWithLocations }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function getStaff(locationId?: string): Promise<StaffMember[]> {
  const client = getClient();
  const allStaff: StaffWithLocations[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage) {
    // Add delay between pagination requests
    if (pageCount > 0) {
      await new Promise(r => setTimeout(r, 350));
    }

    let data: StaffResponse | undefined;
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        data = await client.request<StaffResponse>(
          STAFF_QUERY,
          { first: 100, after: cursor }
        );
        break;
      } catch (e: any) {
        const errMsg = e.message || "";
        const status = e.response?.status;
        const isRetryable =
          errMsg.includes("API limit") || status === 429 ||
          status === 502 || status === 503 || status === 504 ||
          errMsg.includes("502") || errMsg.includes("503") || errMsg.includes("504") ||
          errMsg.includes("Bad Gateway") || errMsg.includes("ECONNRESET");

        if (isRetryable && retries < maxRetries - 1) {
          retries++;
          const waitMatch = errMsg.match(/wait (\d+)ms/);
          const waitTime = waitMatch
            ? parseInt(waitMatch[1]) + 50
            : Math.min(1000 * Math.pow(2, retries), 10000); // Max 10 seconds
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }
        throw e;
      }
    }

    if (!data) {
      throw new Error("Failed to fetch staff after retries");
    }

    allStaff.push(...data.staff.edges.map((edge: { node: StaffWithLocations }) => edge.node));
    hasNextPage = data.staff.pageInfo.hasNextPage;
    cursor = data.staff.pageInfo.endCursor;
    pageCount++;
  }

  // Filter by location if specified
  if (locationId) {
    // Normalize the location ID for comparison (handle both full URN and UUID)
    const normalizedLocationId = locationId.replace("urn:blvd:Location:", "");
    return allStaff.filter((s) =>
      s.locations?.some((loc) => {
        const locId = loc.id.replace("urn:blvd:Location:", "");
        return locId === normalizedLocationId;
      })
    );
  }

  return allStaff;
}

export async function getShifts(
  locationId: string,
  startDate: string,
  endDate: string,
  staffIds?: string[],
  existingStaffMap?: Map<string, StaffMember>
): Promise<StaffShift[]> {
  const client = getClient();

  // Get shift templates from API
  const data = await client.request<{
    shifts: { shifts: StaffShiftTemplate[] };
  }>(SHIFTS_QUERY, {
    locationId,
    startIso8601: startDate,
    endIso8601: endDate,
    staffIds,
  });

  // Use provided staff map or fetch fresh
  let staffMap: Map<string, StaffMember>;
  if (existingStaffMap) {
    staffMap = existingStaffMap;
  } else {
    const staffList = await getStaff(locationId);
    staffMap = new Map(
      staffList.map((s) => [s.id.replace("urn:blvd:Staff:", ""), s])
    );
  }

  // Expand templates into actual shifts for each date in range
  const shifts: StaffShift[] = [];
  // Parse dates as local time by adding T12:00:00 to avoid timezone issues
  const start = new Date(startDate + "T12:00:00");
  const end = new Date(endDate + "T12:00:00");

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayOfWeek = d.getDay(); // 0=Sunday, 1=Monday, etc.
    const dateStr = d.toISOString().split("T")[0];

    for (const template of data.shifts.shifts) {
      // Skip if not available or no staff assigned
      if (!template.available || !template.staffId) continue;

      // Check if this template applies to this day of week
      if (template.day !== dayOfWeek) continue;

      // Check if date is within recurrence window
      if (template.recurrenceStart && dateStr < template.recurrenceStart) continue;
      if (template.recurrenceEnd && dateStr > template.recurrenceEnd) continue;

      // Build the actual shift times
      const startAt = `${dateStr}T${template.clockIn}`;
      const endAt = `${dateStr}T${template.clockOut}`;

      const staffMember = staffMap.get(template.staffId) || {
        id: template.staffId,
        name: "Unknown",
        displayName: "Unknown",
      };

      shifts.push({
        staffId: template.staffId,
        staffMember,
        locationId: template.locationId,
        date: dateStr,
        startAt,
        endAt,
      });
    }
  }

  return shifts;
}

interface AppointmentsResponse {
  appointments: {
    edges: { node: Appointment }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function getAppointments(
  locationId: string,
  startDate?: string,
  endDate?: string,
  staffId?: string,
  // Must paginate ALL results — Boulevard has no server-side date filter,
  // so a low limit can miss future appointments that appear on later pages.
  limit: number = 5000
): Promise<Appointment[]> {
  const client = getClient();
  const allAppointments: Appointment[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let fetched = 0;
  let pageCount = 0;

  // Parse date range for filtering
  const startTime = startDate ? new Date(startDate).getTime() : null;
  const endTime = endDate ? new Date(endDate + "T23:59:59").getTime() : null;

  while (hasNextPage && fetched < limit) {
    // Add delay between pagination requests to avoid rate limiting
    // Each page costs points, refill is 50/sec - be conservative
    if (pageCount > 0) {
      await new Promise(r => setTimeout(r, 350));
    }

    let data: AppointmentsResponse | undefined;
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        data = await client.request<AppointmentsResponse>(
          APPOINTMENTS_QUERY,
          { locationId, first: 100, after: cursor }
        );
        break;
      } catch (e: any) {
        const errMsg = e.message || "";
        const status = e.response?.status;
        const isRetryable =
          errMsg.includes("API limit") || status === 429 ||
          status === 502 || status === 503 || status === 504 ||
          errMsg.includes("502") || errMsg.includes("503") || errMsg.includes("504") ||
          errMsg.includes("Bad Gateway") || errMsg.includes("ECONNRESET");

        if (isRetryable && retries < maxRetries - 1) {
          retries++;
          const waitMatch = errMsg.match(/wait (\d+)ms/);
          const waitTime = waitMatch
            ? parseInt(waitMatch[1]) + 50
            : Math.min(1000 * Math.pow(2, retries), 10000);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }
        throw e;
      }
    }

    if (!data) {
      throw new Error("Failed to fetch appointments after retries");
    }

    for (const edge of data.appointments.edges) {
      const apt = edge.node;

      // Filter by cancelled status
      if (apt.cancelled) continue;

      // Filter by date range
      const aptTime = new Date(apt.startAt).getTime();
      if (startTime && aptTime < startTime) continue;
      if (endTime && aptTime > endTime) continue;

      // Filter by staff ID if specified
      if (staffId) {
        const matchesStaff = apt.appointmentServices?.some(
          (svc) => svc.staff?.id === staffId
        );
        if (!matchesStaff) continue;
      }

      allAppointments.push(apt);
      fetched++;

      if (fetched >= limit) break;
    }

    hasNextPage = data.appointments.pageInfo.hasNextPage;
    cursor = data.appointments.pageInfo.endCursor;
    pageCount++;

    // Do NOT early-exit based on date ordering — Boulevard returns appointments
    // in an undefined order (not necessarily chronological). Stopping early can
    // miss future appointments on later pages, causing BTBs to be placed on
    // shifts that already have bookings.
  }

  return allAppointments;
}

/**
 * Get appointments filtered by creation date (when booked, not when scheduled)
 * Uses query string filtering on createdAt field
 */
export async function getAppointmentsByCreatedDate(
  locationId: string,
  createdAfter: string,
  createdBefore?: string,
  limit: number = 1000
): Promise<Appointment[]> {
  const client = getClient();
  const allAppointments: Appointment[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let fetched = 0;
  let pageCount = 0;

  // Parse date range for filtering
  const afterTime = new Date(createdAfter).getTime();
  const beforeTime = createdBefore ? new Date(createdBefore + "T23:59:59").getTime() : null;

  while (hasNextPage && fetched < limit) {
    if (pageCount > 0) {
      await new Promise(r => setTimeout(r, 350));
    }

    let data: AppointmentsResponse | undefined;
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        data = await client.request<AppointmentsResponse>(
          APPOINTMENTS_QUERY,
          { locationId, first: 100, after: cursor }
        );
        break;
      } catch (e: any) {
        const errMsg = e.message || "";
        const status = e.response?.status;
        const isRetryable =
          errMsg.includes("API limit") || status === 429 ||
          status === 502 || status === 503 || status === 504 ||
          errMsg.includes("502") || errMsg.includes("503") || errMsg.includes("504") ||
          errMsg.includes("Bad Gateway") || errMsg.includes("ECONNRESET");

        if (isRetryable && retries < maxRetries - 1) {
          retries++;
          const waitMatch = errMsg.match(/wait (\d+)ms/);
          const waitTime = waitMatch
            ? parseInt(waitMatch[1]) + 50
            : Math.min(1000 * Math.pow(2, retries), 10000);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }
        throw e;
      }
    }

    if (!data) {
      throw new Error("Failed to fetch appointments after retries");
    }

    for (const edge of data.appointments.edges) {
      const apt = edge.node;

      // Skip cancelled appointments
      if (apt.cancelled) continue;

      // Filter by createdAt range
      if (!apt.createdAt) continue;
      const createdTime = new Date(apt.createdAt).getTime();
      if (createdTime < afterTime) continue;
      if (beforeTime && createdTime > beforeTime) continue;

      allAppointments.push(apt);
      fetched++;

      if (fetched >= limit) break;
    }

    hasNextPage = data.appointments.pageInfo.hasNextPage;
    cursor = data.appointments.pageInfo.endCursor;
    pageCount++;
  }

  return allAppointments;
}

interface TimeblocksResponse {
  timeblocks: {
    edges: { node: Timeblock }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function getTimeblocks(
  locationId: string,
  staffId?: string,
  startDate?: string,
  endDate?: string
): Promise<Timeblock[]> {
  const client = getClient();
  const allTimeblocks: Timeblock[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage) {
    // Add delay between pagination requests to avoid rate limiting
    // Each page costs ~16 points, refill is 50/sec, so need ~320ms between pages
    if (pageCount > 0) {
      await new Promise(r => setTimeout(r, 350));
    }

    let data: TimeblocksResponse | undefined;
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        data = await client.request<TimeblocksResponse>(
          TIMEBLOCKS_QUERY,
          { locationId, first: 100, after: cursor }
        );
        break;
      } catch (e: any) {
        const errMsg = e.message || "";
        const status = e.response?.status;
        const isRetryable =
          errMsg.includes("API limit") || status === 429 ||
          status === 502 || status === 503 || status === 504 ||
          errMsg.includes("502") || errMsg.includes("503") || errMsg.includes("504") ||
          errMsg.includes("Bad Gateway") || errMsg.includes("ECONNRESET");

        if (isRetryable && retries < maxRetries - 1) {
          retries++;
          const waitMatch = errMsg.match(/wait (\d+)ms/);
          const waitTime = waitMatch
            ? parseInt(waitMatch[1]) + 50
            : Math.min(1000 * Math.pow(2, retries), 10000);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }
        throw e;
      }
    }

    if (!data) {
      throw new Error("Failed to fetch timeblocks after retries");
    }

    for (const edge of data.timeblocks.edges) {
      const tb = edge.node;
      // Skip cancelled timeblocks
      if (tb.cancelled) continue;
      // Filter by staff if specified
      if (staffId && tb.staff?.id !== staffId) continue;
      allTimeblocks.push(tb);
    }

    hasNextPage = data.timeblocks.pageInfo.hasNextPage;
    cursor = data.timeblocks.pageInfo.endCursor;
    pageCount++;
  }

  // Client-side date filtering (Boulevard has no server-side date filter)
  if (startDate || endDate) {
    const startTime = startDate ? new Date(startDate + "T00:00:00").getTime() : -Infinity;
    const endTime = endDate ? new Date(endDate + "T23:59:59").getTime() : Infinity;
    return allTimeblocks.filter((tb) => {
      const tbStart = new Date(tb.startAt).getTime();
      return tbStart >= startTime && tbStart <= endTime;
    });
  }

  return allTimeblocks;
}

export async function createTimeblock(input: {
  locationId: string;
  staffId: string;
  startTime: string;
  duration: number;
  title?: string;
  reason?: string;
}): Promise<Timeblock> {
  const client = getClient();
  const data = await client.request<{
    createTimeblock: { timeblock: Timeblock };
  }>(CREATE_TIMEBLOCK_MUTATION, { input });
  return data.createTimeblock.timeblock;
}

export async function deleteTimeblock(timeblockId: string): Promise<boolean> {
  const client = getClient();
  await client.request(DELETE_TIMEBLOCK_MUTATION, {
    input: { id: timeblockId },
  });
  return true;
}

// BTB Management Configuration
export interface BTBCleanupConfig {
  utilizationThreshold: number; // Default 50% - above this, consider removing BTB
  minGapMinutes: number; // Default 60 (1 hour) - remove BTB if gap to appointment is less
  lookAheadDays: number; // Default 14
  emptyWindowMinutes: number; // Default 120 (2 hours) - add BTB if no appointments in this window
  btbDurationMinutes: number; // Default 60 (1 hour) - duration of BTB blocks to create
  // Auto-add rule: add BTB when there's enough space (regardless of utilization)
  autoAddGapMinutes: number; // Default 90 - add BTB if space >= this
  autoAddBtbDuration: number; // Default 30 - duration of auto-added BTB blocks
}

export const DEFAULT_BTB_CONFIG: BTBCleanupConfig = {
  utilizationThreshold: 50,
  minGapMinutes: 60,
  lookAheadDays: 14,
  emptyWindowMinutes: 120,
  btbDurationMinutes: 60,
  autoAddGapMinutes: 90,
  autoAddBtbDuration: 30,
};

// Result of analyzing a shift for BTB management
export interface BTBAnalysisResult {
  shift: StaffShift;
  utilizationPercent: number;
  // Existing BTB blocks
  startBlock?: Timeblock;
  endBlock?: Timeblock;
  // Removal flags (high utilization, appointments close to shift edges)
  startBlockShouldRemove: boolean;
  endBlockShouldRemove: boolean;
  startGapMinutes?: number;
  endGapMinutes?: number;
  // Addition flags (low utilization, no appointments near shift edges)
  startBlockShouldAdd: boolean;
  endBlockShouldAdd: boolean;
  // Auto-add flags (when space >= autoAddGapMinutes, regardless of utilization)
  startAutoAdd: boolean;
  endAutoAdd: boolean;
  // Appointment info
  firstAppointmentStart?: string;
  lastAppointmentEnd?: string;
  // Minutes from shift start to first appointment / last appointment to shift end
  minutesToFirstAppointment?: number;
  minutesAfterLastAppointment?: number;
}

/**
 * Check if a timeblock is a BTB block (title contains "btb" or "b2b" case-insensitive)
 */
export function isBTBBlock(timeblock: Timeblock): boolean {
  const title = timeblock.title?.toLowerCase() ?? "";
  return title.includes("btb") || title.includes("b2b");
}

/**
 * Analyze a shift to determine if BTB blocks should be added or removed
 *
 * REMOVE BTB: utilization >= threshold AND gap to first/last appointment < minGapMinutes
 * ADD BTB: utilization < threshold AND no appointments in first/last emptyWindowMinutes
 */
export function analyzeBTBBlocks(
  shift: StaffShift,
  appointments: Appointment[],
  timeblocks: Timeblock[],
  config: BTBCleanupConfig = DEFAULT_BTB_CONFIG
): BTBAnalysisResult {
  const shiftStart = new Date(shift.startAt).getTime();
  const shiftEnd = new Date(shift.endAt).getTime();
  const shiftDurationMinutes = (shiftEnd - shiftStart) / (1000 * 60);

  // Get appointments for this shift and staff member
  const shiftAppointments = appointments
    .filter((apt) => {
      const aptStart = new Date(apt.startAt).getTime();
      const aptEnd = new Date(apt.endAt).getTime();
      const overlaps = aptStart < shiftEnd && aptEnd > shiftStart;
      const matchesStaff = apt.appointmentServices?.some(
        (svc) => svc.staff?.id === shift.staffMember.id
      );
      return overlaps && matchesStaff && !apt.cancelled;
    })
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  // Calculate blocked time from ALL timeblocks (BTB, DNB, lunch, etc.) for this staff
  const shiftStaffId = shift.staffMember.id.replace("urn:blvd:Staff:", "");
  const staffTimeblocks = timeblocks.filter((tb) => {
    const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
    if (tbStaffId !== shiftStaffId) return false;
    const tbStart = new Date(tb.startAt).getTime();
    const tbEnd = new Date(tb.endAt).getTime();
    return tbStart < shiftEnd && tbEnd > shiftStart;
  });

  let blockedMinutes = 0;
  for (const tb of staffTimeblocks) {
    const tbStart = Math.max(new Date(tb.startAt).getTime(), shiftStart);
    const tbEnd = Math.min(new Date(tb.endAt).getTime(), shiftEnd);
    blockedMinutes += (tbEnd - tbStart) / (1000 * 60);
  }

  // Calculate utilization: booked / (shift - blocked)
  const shiftMinutes = (shiftEnd - shiftStart) / (1000 * 60);
  const availableMinutes = Math.max(shiftMinutes - blockedMinutes, 0);
  let bookedMinutes = 0;
  for (const apt of shiftAppointments) {
    const aptStart = Math.max(new Date(apt.startAt).getTime(), shiftStart);
    const aptEnd = Math.min(new Date(apt.endAt).getTime(), shiftEnd);
    bookedMinutes += (aptEnd - aptStart) / (1000 * 60);
  }
  const utilizationPercent = availableMinutes > 0
    ? Math.round((bookedMinutes / availableMinutes) * 1000) / 10
    : 0;

  // Find BTB blocks for this shift and staff member
  const staffBTBBlocks = timeblocks.filter((tb) => {
    if (!isBTBBlock(tb)) return false;
    const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
    if (tbStaffId !== shiftStaffId) return false;
    const tbStart = new Date(tb.startAt).getTime();
    const tbEnd = new Date(tb.endAt).getTime();
    return tbStart < shiftEnd && tbEnd > shiftStart;
  });

  // Identify start block (near shift start) and end block (near shift end)
  const startBlock = staffBTBBlocks.find((tb) => {
    const tbStart = new Date(tb.startAt).getTime();
    // Within 15 minutes of shift start
    return Math.abs(tbStart - shiftStart) < 15 * 60 * 1000;
  });

  const endBlock = staffBTBBlocks.find((tb) => {
    const tbEnd = new Date(tb.endAt).getTime();
    // Within 15 minutes of shift end
    return Math.abs(tbEnd - shiftEnd) < 15 * 60 * 1000;
  });

  // Calculate minutes to first appointment and after last appointment
  let minutesToFirstAppointment: number | undefined;
  let minutesAfterLastAppointment: number | undefined;

  if (shiftAppointments.length > 0) {
    const firstAptStart = new Date(shiftAppointments[0].startAt).getTime();
    const lastAptEnd = new Date(shiftAppointments[shiftAppointments.length - 1].endAt).getTime();
    minutesToFirstAppointment = Math.round((firstAptStart - shiftStart) / (1000 * 60));
    minutesAfterLastAppointment = Math.round((shiftEnd - lastAptEnd) / (1000 * 60));
  }

  const result: BTBAnalysisResult = {
    shift,
    utilizationPercent,
    startBlock,
    endBlock,
    startBlockShouldRemove: false,
    endBlockShouldRemove: false,
    startBlockShouldAdd: false,
    endBlockShouldAdd: false,
    startAutoAdd: false,
    endAutoAdd: false,
    minutesToFirstAppointment,
    minutesAfterLastAppointment,
    firstAppointmentStart: shiftAppointments[0]?.startAt,
    lastAppointmentEnd: shiftAppointments[shiftAppointments.length - 1]?.endAt,
  };

  // REMOVE BTB blocks when appointments are close — regardless of utilization.
  // REMOVE BTB: only when utilization >= threshold AND appointment is close
  if (utilizationPercent >= config.utilizationThreshold) {
    if (startBlock && shiftAppointments.length > 0) {
      const blockEnd = new Date(startBlock.endAt).getTime();
      const firstAptStart = new Date(shiftAppointments[0].startAt).getTime();
      const gapMinutes = (firstAptStart - blockEnd) / (1000 * 60);

      result.startGapMinutes = Math.round(gapMinutes);

      if (gapMinutes < config.minGapMinutes) {
        result.startBlockShouldRemove = true;
      }
    }

    if (endBlock && shiftAppointments.length > 0) {
      const blockStart = new Date(endBlock.startAt).getTime();
      const lastApt = shiftAppointments[shiftAppointments.length - 1];
      const lastAptEnd = new Date(lastApt.endAt).getTime();
      const gapMinutes = (blockStart - lastAptEnd) / (1000 * 60);

      result.endGapMinutes = Math.round(gapMinutes);

      if (gapMinutes < config.minGapMinutes) {
        result.endBlockShouldRemove = true;
      }
    }
  }

  // Helper: check if ANY existing block (BTB, DNB, lunch, personal, etc.)
  // overlaps a proposed time range for this staff
  const anyBlockOverlaps = (proposedStartMs: number, proposedEndMs: number): boolean => {
    return staffTimeblocks.some(tb => {
      const tbStart = new Date(tb.startAt).getTime();
      const tbEnd = new Date(tb.endAt).getTime();
      return proposedStartMs < tbEnd && proposedEndMs > tbStart;
    });
  };

  // LOW UTILIZATION: Consider adding BTB blocks
  if (utilizationPercent < config.utilizationThreshold) {
    // Only add if shift is long enough (4 hours minimum)
    const minShiftForBTB = 240; // 4 hours
    if (shiftDurationMinutes < minShiftForBTB) {
      return result;
    }

    // Check if we should add start BTB
    // No existing block of ANY type AND (no appointments OR first appointment is >= emptyWindowMinutes from shift start)
    if (!startBlock) {
      const proposedEndMs = shiftStart + config.btbDurationMinutes * 60 * 1000;
      const noBlockConflict = !anyBlockOverlaps(shiftStart, proposedEndMs);
      const firstAptFarEnough = shiftAppointments.length === 0 ||
        minutesToFirstAppointment! >= config.emptyWindowMinutes;

      if (noBlockConflict && firstAptFarEnough) {
        result.startBlockShouldAdd = true;
      }
    }

    // Check if we should add end BTB
    // No existing block of ANY type AND (no appointments OR last appointment ends >= emptyWindowMinutes before shift end)
    if (!endBlock) {
      const proposedStartMs = shiftEnd - config.btbDurationMinutes * 60 * 1000;
      const noBlockConflict = !anyBlockOverlaps(proposedStartMs, shiftEnd);
      const lastAptFarEnough = shiftAppointments.length === 0 ||
        minutesAfterLastAppointment! >= config.emptyWindowMinutes;

      if (noBlockConflict && lastAptFarEnough) {
        result.endBlockShouldAdd = true;
      }
    }
  }

  // AUTO-ADD RULE: Add short BTB when there's enough space (regardless of utilization)
  // This triggers via webhook when appointments are cancelled/moved
  if (!startBlock && minutesToFirstAppointment !== undefined) {
    const proposedEndMs = shiftStart + config.btbDurationMinutes * 60 * 1000;
    if (minutesToFirstAppointment >= config.autoAddGapMinutes && !anyBlockOverlaps(shiftStart, proposedEndMs)) {
      result.startAutoAdd = true;
    }
  }
  if (!endBlock && minutesAfterLastAppointment !== undefined) {
    const proposedStartMs = shiftEnd - config.btbDurationMinutes * 60 * 1000;
    if (minutesAfterLastAppointment >= config.autoAddGapMinutes && !anyBlockOverlaps(proposedStartMs, shiftEnd)) {
      result.endAutoAdd = true;
    }
  }

  return result;
}

/**
 * Execute BTB removal actions for a single analysis result.
 * Creation is handled by createBTBIfAllowed() — this only does removals.
 */
export async function executeBTBRemovals(
  analysis: BTBAnalysisResult,
): Promise<{
  removed: string[];
  errors: string[];
}> {
  const removed: string[] = [];
  const errors: string[] = [];

  const staffName = analysis.shift.staffMember.displayName || analysis.shift.staffMember.name;

  if (analysis.startBlockShouldRemove && analysis.startBlock) {
    try {
      await deleteTimeblock(analysis.startBlock.id);
      removed.push(`${staffName}: removed start BTB (gap=${analysis.startGapMinutes}min, util=${analysis.utilizationPercent}%)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${staffName}: failed to remove start BTB - ${msg}`);
    }
  }

  if (analysis.endBlockShouldRemove && analysis.endBlock) {
    try {
      await deleteTimeblock(analysis.endBlock.id);
      removed.push(`${staffName}: removed end BTB (gap=${analysis.endGapMinutes}min, util=${analysis.utilizationPercent}%)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${staffName}: failed to remove end BTB - ${msg}`);
    }
  }

  return { removed, errors };
}

/**
 * @deprecated Use executeBTBRemovals() for removals and createBTBIfAllowed() for additions.
 */
export async function executeBTBActions(
  analysis: BTBAnalysisResult,
  _config: BTBCleanupConfig = DEFAULT_BTB_CONFIG,
  _existingTimeblocks: Timeblock[] = []
): Promise<{ removed: string[]; added: string[]; errors: string[] }> {
  const { removed, errors } = await executeBTBRemovals(analysis);
  return { removed, added: [], errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// RULES ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export interface BTBRule {
  id: string;
  minGap: number;
  maxGap: number | null;
  btbDuration: number;
  label: string;
  enabled: boolean;
}

const DEFAULT_RULES: BTBRule[] = [
  { id: "rule-1", minGap: 120, maxGap: null, btbDuration: 60, label: "Large gap (2h+)", enabled: true },
  { id: "rule-2", minGap: 90, maxGap: 119, btbDuration: 30, label: "Medium gap (90-119min)", enabled: true },
  { id: "rule-3", minGap: 60, maxGap: 89, btbDuration: 15, label: "Small gap (60-89min)", enabled: true },
];

export function loadRules(rulesFilePath: string): BTBRule[] {
  try {
    if (existsSync(rulesFilePath)) {
      const data = JSON.parse(readFileSync(rulesFilePath, "utf-8"));
      return data.rules || DEFAULT_RULES;
    }
  } catch (e) {
    console.error("Error reading rules file:", e);
  }
  return DEFAULT_RULES;
}

export function matchRule(gapMinutes: number, rules: BTBRule[]): BTBRule | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (gapMinutes >= rule.minGap && (rule.maxGap === null || gapMinutes <= rule.maxGap)) {
      return rule;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED BTB CREATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Single entry point for creating BTBs. Uses rules engine for duration,
 * checks all block overlaps before creating. No fallback to flat config.
 */
export async function createBTBIfAllowed(opts: {
  shift: StaffShift;
  position: "start" | "end";
  gapMinutes: number;
  rules: BTBRule[];
  existingTimeblocks: Timeblock[];
  locationId: string;
}): Promise<{ added: string | null; error: string | null }> {
  const { shift, position, gapMinutes, rules, existingTimeblocks, locationId } = opts;
  const staffName = shift.staffMember.displayName || shift.staffMember.name;
  const staffId = shift.staffMember.id.replace("urn:blvd:Staff:", "");

  // 1. Match rule — no match = no BTB
  const rule = matchRule(gapMinutes, rules);
  if (!rule) {
    return { added: null, error: null };
  }

  // 2. Calculate proposed time
  let proposedStart: Date;
  if (position === "start") {
    proposedStart = new Date(shift.startAt);
  } else {
    const shiftEnd = new Date(shift.endAt);
    proposedStart = new Date(shiftEnd.getTime() - rule.btbDuration * 60 * 1000);
  }
  const proposedEnd = new Date(proposedStart.getTime() + rule.btbDuration * 60 * 1000);

  // 3. Check overlap against ALL existing blocks for this staff
  const proposedStartMs = proposedStart.getTime();
  const proposedEndMs = proposedEnd.getTime();

  const overlaps = existingTimeblocks.some((tb) => {
    const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
    if (tbStaffId !== staffId) return false;
    const tbStart = new Date(tb.startAt).getTime();
    const tbEnd = new Date(tb.endAt).getTime();
    return proposedStartMs < tbEnd && proposedEndMs > tbStart;
  });

  if (overlaps) {
    return { added: null, error: null }; // not an error, just skipped
  }

  // 4. Create the block
  try {
    const ensureURN = (id: string, type: "Location" | "Staff"): string =>
      id.startsWith("urn:blvd:") ? id : `urn:blvd:${type}:${id}`;

    await createTimeblock({
      locationId: ensureURN(locationId, "Location"),
      staffId: ensureURN(shift.staffMember.id, "Staff"),
      startTime: proposedStart.toISOString(),
      duration: rule.btbDuration,
      title: "Auto - BTB",
      reason: "PERSONAL",
    });

    // 5. Push synthetic entry to prevent same-batch duplicates
    existingTimeblocks.push({
      id: "pending",
      startAt: proposedStart.toISOString(),
      endAt: proposedEnd.toISOString(),
      duration: rule.btbDuration,
      title: "Auto - BTB",
      staff: { id: shift.staffMember.id, name: staffName },
    });

    const msg = `${staffName}: ${position} BTB added (${rule.btbDuration}min, ${gapMinutes}min gap, ${rule.label})`;
    return { added: msg, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { added: null, error: `${staffName}: failed to add ${position} BTB - ${msg}` };
  }
}

/**
 * @deprecated Use getTimeblocks(locationId, staffId, startDate, endDate) instead
 */
export async function getTimeblocksInRange(
  locationId: string,
  startDate: string,
  endDate: string,
  staffId?: string
): Promise<Timeblock[]> {
  return getTimeblocks(locationId, staffId, startDate, endDate);
}

// Utility: Calculate shift utilization
export interface ShiftUtilization {
  shift: StaffShift;
  availableMinutes: number;
  bookedMinutes: number;
  utilizationPercent: number;
  appointments: Appointment[];
}

export function calculateShiftUtilization(
  shift: StaffShift,
  appointments: Appointment[]
): ShiftUtilization {
  const shiftStart = new Date(shift.startAt).getTime();
  const shiftEnd = new Date(shift.endAt).getTime();
  const availableMinutes = (shiftEnd - shiftStart) / (1000 * 60);

  // Filter appointments that overlap with this shift and match staff
  const shiftAppointments = appointments.filter((apt) => {
    const aptStart = new Date(apt.startAt).getTime();
    const aptEnd = new Date(apt.endAt).getTime();

    // Check overlap
    const overlaps = aptStart < shiftEnd && aptEnd > shiftStart;

    // Check if appointment is for this staff member
    const matchesStaff = apt.appointmentServices?.some(
      (svc) => svc.staff?.id === shift.staffMember.id
    );

    return overlaps && matchesStaff && !apt.cancelled;
  });

  // Sum up booked minutes (accounting for partial overlaps)
  let bookedMinutes = 0;
  for (const apt of shiftAppointments) {
    const aptStart = Math.max(new Date(apt.startAt).getTime(), shiftStart);
    const aptEnd = Math.min(new Date(apt.endAt).getTime(), shiftEnd);
    bookedMinutes += (aptEnd - aptStart) / (1000 * 60);
  }

  const utilizationPercent =
    availableMinutes > 0 ? (bookedMinutes / availableMinutes) * 100 : 0;

  return {
    shift,
    availableMinutes,
    bookedMinutes,
    utilizationPercent: Math.round(utilizationPercent * 10) / 10,
    appointments: shiftAppointments,
  };
}

// ============================================
// WEBHOOK MANAGEMENT
// ============================================

export interface Webhook {
  id: string;
  name: string;
  url: string;
  subscriptions: { id: string; eventType: string; enabled: boolean }[];
}

const LIST_WEBHOOKS_QUERY = `
  query ListWebhooks {
    webhooks(first: 100) {
      edges {
        node {
          id
          name
          url
          subscriptions {
            id
            eventType
            enabled
          }
        }
      }
    }
  }
`;

const CREATE_WEBHOOK_MUTATION = `
  mutation CreateWebhook($input: CreateWebhookInput!) {
    createWebhook(input: $input) {
      webhook {
        id
        name
        url
        subscriptions {
          id
          eventType
          enabled
        }
      }
    }
  }
`;

const DELETE_WEBHOOK_MUTATION = `
  mutation DeleteWebhook($input: DeleteWebhookInput!) {
    deleteWebhook(input: $input) {
      webhook {
        id
      }
    }
  }
`;

export async function listWebhooks(): Promise<Webhook[]> {
  const client = getClient();
  const data = await client.request<{ webhooks: { edges: { node: Webhook }[] } }>(LIST_WEBHOOKS_QUERY);
  return data.webhooks.edges.map(e => e.node);
}

export async function createWebhook(
  locationId: string,
  url: string,
  name: string,
  eventTypes: string[] = ["APPOINTMENT_CREATED", "APPOINTMENT_UPDATED", "APPOINTMENT_CANCELLED", "APPOINTMENT_RESCHEDULED"]
): Promise<Webhook> {
  const client = getClient();
  const data = await client.request<{ createWebhook: { webhook: Webhook } }>(CREATE_WEBHOOK_MUTATION, {
    input: {
      locationId,
      url,
      name,
      subscriptions: eventTypes.map(eventType => ({ eventType })),
    },
  });
  return data.createWebhook.webhook;
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  const client = getClient();
  await client.request(DELETE_WEBHOOK_MUTATION, { input: { id: webhookId } });
}

// ============================================
// SERVICE MANAGEMENT
// ============================================

export interface Service {
  id: string;
  name: string;
  active: boolean;
  defaultDuration: number;
  defaultPrice: number;
  category?: { id: string; name: string };
}

const LIST_SERVICES_QUERY = gql`
  query GetServices($first: Int!, $after: String) {
    services(first: $first, after: $after) {
      edges {
        node {
          id
          name
          active
          defaultDuration
          defaultPrice
          category { id name }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const GET_SERVICE_QUERY = gql`
  query GetService($id: ID!) {
    service(id: $id) {
      id
      name
      active
      defaultDuration
      defaultPrice
      category { id name }
    }
  }
`;

const SERVICE_DEACTIVATE_AT_LOCATION_MUTATION = gql`
  mutation ServiceDeactivateAtLocation($input: ServiceDeactivateAtLocationInput!) {
    serviceDeactivateAtLocation(input: $input) {
      serviceId
    }
  }
`;

const SERVICE_ACTIVATE_AT_LOCATION_MUTATION = gql`
  mutation ServiceActivateAtLocation($input: ServiceActivateAtLocationInput!) {
    serviceActivateAtLocation(input: $input) {
      serviceId
    }
  }
`;

interface ServicesResponse {
  services: {
    edges: { node: Service }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function getServices(): Promise<Service[]> {
  const client = getClient();
  const allServices: Service[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: ServicesResponse = await client.request<ServicesResponse>(
      LIST_SERVICES_QUERY,
      { first: 100, after: cursor }
    );

    for (const edge of data.services.edges) {
      allServices.push(edge.node);
    }

    hasNextPage = data.services.pageInfo.hasNextPage;
    cursor = data.services.pageInfo.endCursor;
  }

  return allServices;
}

export async function getService(serviceId: string): Promise<Service | null> {
  const client = getClient();
  try {
    const data = await client.request<{ service: Service }>(GET_SERVICE_QUERY, { id: serviceId });
    return data.service;
  } catch (error) {
    console.error(`Failed to get service ${serviceId}:`, error);
    return null;
  }
}

export async function deactivateServiceAtLocation(
  serviceId: string,
  locationId: string
): Promise<string> {
  const client = getClient();
  const data = await client.request<{ serviceDeactivateAtLocation: { serviceId: string } }>(
    SERVICE_DEACTIVATE_AT_LOCATION_MUTATION,
    { input: { serviceId, locationId } }
  );
  return data.serviceDeactivateAtLocation.serviceId;
}

export async function activateServiceAtLocation(
  serviceId: string,
  locationId: string
): Promise<string> {
  const client = getClient();
  const data = await client.request<{ serviceActivateAtLocation: { serviceId: string } }>(
    SERVICE_ACTIVATE_AT_LOCATION_MUTATION,
    { input: { serviceId, locationId } }
  );
  return data.serviceActivateAtLocation.serviceId;
}

// Deactivate a service at ALL locations (business-wide)
export async function deactivateServiceBusinessWide(serviceId: string): Promise<{
  serviceId: string;
  deactivatedAt: string[];
  errors: { locationId: string; error: string }[];
}> {
  const locations = await getLocations();
  const deactivatedAt: string[] = [];
  const errors: { locationId: string; error: string }[] = [];

  for (const location of locations) {
    try {
      await deactivateServiceAtLocation(serviceId, location.id);
      deactivatedAt.push(location.name);
    } catch (e) {
      // Service might already be inactive at this location, or not available there
      errors.push({
        locationId: location.id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return {
    serviceId,
    deactivatedAt,
    errors,
  };
}

// Activate a service at ALL locations (business-wide)
export async function activateServiceBusinessWide(serviceId: string): Promise<{
  serviceId: string;
  activatedAt: string[];
  errors: { locationId: string; error: string }[];
}> {
  const locations = await getLocations();
  const activatedAt: string[] = [];
  const errors: { locationId: string; error: string }[] = [];

  for (const location of locations) {
    try {
      await activateServiceAtLocation(serviceId, location.id);
      activatedAt.push(location.name);
    } catch (e) {
      errors.push({
        locationId: location.id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return {
    serviceId,
    activatedAt,
    errors,
  };
}

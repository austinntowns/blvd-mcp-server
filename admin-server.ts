/**
 * BTB Admin Server - Standalone web UI for BTB management
 *
 * Run: npx tsx admin-server.ts
 * Access: http://localhost:3001/btb-admin
 */

import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  getLocations,
  getShifts,
  getAppointments,
  getTimeblocks,
  getTimeblocksInRange,
  deleteTimeblock,
  createTimeblock,
  analyzeBTBBlocks,
  executeBTBActions,
  DEFAULT_BTB_CONFIG,
  type BTBCleanupConfig,
} from "./lib/boulevard.js";

const app = new Hono();

// Helper for delays
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Check if error is retryable
function isRetryableError(e: any): boolean {
  const errMsg = e.message || "";
  const status = e.response?.status;

  // Rate limiting
  if (errMsg.includes("API limit") || status === 429) return true;

  // Server errors (502, 503, 504)
  if (status === 502 || status === 503 || status === 504) return true;
  if (errMsg.includes("502") || errMsg.includes("503") || errMsg.includes("504")) return true;
  if (errMsg.includes("Bad Gateway") || errMsg.includes("Service Unavailable") || errMsg.includes("Gateway Timeout")) return true;

  // Connection errors
  if (errMsg.includes("ECONNRESET") || errMsg.includes("ETIMEDOUT") || errMsg.includes("ECONNREFUSED")) return true;
  if (errMsg.includes("socket hang up") || errMsg.includes("network")) return true;

  return false;
}

// Get retry delay based on error type
function getRetryDelay(e: any, attempt: number, baseDelay: number): number {
  const errMsg = e.message || "";

  // Rate limiting - parse exact wait time from Boulevard error
  const waitMatch = errMsg.match(/wait (\d+)ms/);
  if (waitMatch) {
    return parseInt(waitMatch[1]) + 100;
  }

  // Server errors - longer delays with exponential backoff
  const status = e.response?.status;
  if (status === 502 || status === 503 || status === 504) {
    return Math.min(baseDelay * Math.pow(2, attempt), 10000); // Max 10 seconds
  }

  // Default exponential backoff
  return baseDelay * Math.pow(2, attempt);
}

// Retry wrapper for API calls with transient error handling
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 10, baseDelay = 500): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;

      if (isRetryableError(e) && attempt < maxRetries - 1) {
        const delay = getRetryDelay(e, attempt, baseDelay);
        console.log(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("Max retries exceeded");
}

// Enrollment file path
const ENROLLMENT_FILE = join(__dirname, "enrolled-locations.json");
const CHANGELOG_FILE = join(__dirname, "btb-changelog.json");

interface EnrollmentData {
  locations: string[];
  updatedAt: string | null;
}

interface ChangelogEntry {
  timestamp: string;
  action: "add" | "remove" | "bootstrap" | "webhook";
  mode: "dry-run" | "execute";
  location: string;
  details: string[];
  added: number;
  skipped: number;
  errors: number;
  removed?: number;
}

interface ChangelogData {
  entries: ChangelogEntry[];
}

function readEnrollment(): EnrollmentData {
  try {
    if (existsSync(ENROLLMENT_FILE)) {
      return JSON.parse(readFileSync(ENROLLMENT_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error reading enrollment file:", e);
  }
  return { locations: [], updatedAt: null };
}

function writeEnrollment(data: EnrollmentData): void {
  data.updatedAt = new Date().toISOString();
  writeFileSync(ENROLLMENT_FILE, JSON.stringify(data, null, 2));
}

export function getEnrolledLocations(): string[] {
  return readEnrollment().locations;
}

function readChangelog(): ChangelogData {
  try {
    if (existsSync(CHANGELOG_FILE)) {
      return JSON.parse(readFileSync(CHANGELOG_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error reading changelog file:", e);
  }
  return { entries: [] };
}

function writeChangelog(data: ChangelogData): void {
  // Keep only last 500 entries
  if (data.entries.length > 500) {
    data.entries = data.entries.slice(0, 500);
  }
  writeFileSync(CHANGELOG_FILE, JSON.stringify(data, null, 2));
}

function logChange(entry: Omit<ChangelogEntry, "timestamp">): void {
  const data = readChangelog();
  data.entries.unshift({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  writeChangelog(data);
}

// Default config - can be overridden per request
const DEFAULT_CONFIG = {
  lookAheadDays: 14,
  minShiftHours: 4,
  utilizationThreshold: 50,
  emptyWindowMinutes: 120,
  btbDurationMinutes: 60,
  minGapMinutes: 60,
};

// API: List all locations
app.get("/api/locations", async (c) => {
  try {
    const locations = await getLocations();
    return c.json({
      locations: locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
      })),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// API: Get current config
app.get("/api/config", (c) => {
  return c.json(DEFAULT_CONFIG);
});

// API: Get enrolled locations
app.get("/api/enrollment", (c) => {
  const data = readEnrollment();
  return c.json(data);
});

// API: Get changelog
app.get("/api/changelog", (c) => {
  const data = readChangelog();
  const limit = parseInt(c.req.query("limit") || "100");
  return c.json({
    entries: data.entries.slice(0, limit),
    total: data.entries.length,
  });
});

// API: Clear changelog
app.delete("/api/changelog", (c) => {
  writeChangelog({ entries: [] });
  return c.json({ success: true });
});

// API: Update enrollment (add/remove locations)
app.post("/api/enrollment", async (c) => {
  try {
    const body = await c.req.json();
    const { locationIds, action } = body;

    if (!locationIds || !Array.isArray(locationIds)) {
      return c.json({ error: "locationIds required" }, 400);
    }

    const data = readEnrollment();

    if (action === "add") {
      const newIds = locationIds.filter(id => !data.locations.includes(id));
      data.locations.push(...newIds);
    } else if (action === "remove") {
      data.locations = data.locations.filter(id => !locationIds.includes(id));
    } else if (action === "set") {
      data.locations = locationIds;
    } else {
      return c.json({ error: "action must be 'add', 'remove', or 'set'" }, 400);
    }

    writeEnrollment(data);
    return c.json({ success: true, enrolled: data.locations.length });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// API: Run BTB bootstrap with streaming progress
app.post("/api/btb/bootstrap-stream", async (c) => {
  const body = await c.req.json();
  const { locationIds, dryRun = true, config: userConfig = {} } = body;

  if (!locationIds || !Array.isArray(locationIds) || locationIds.length === 0) {
    return c.json({ error: "No locations selected" }, 400);
  }

  // Merge user config with defaults
  const settings = {
    lookAheadDays: userConfig.lookAheadDays ?? DEFAULT_CONFIG.lookAheadDays,
    minShiftHours: userConfig.minShiftHours ?? DEFAULT_CONFIG.minShiftHours,
    utilizationThreshold: userConfig.utilizationThreshold ?? DEFAULT_CONFIG.utilizationThreshold,
    emptyWindowMinutes: userConfig.emptyWindowMinutes ?? DEFAULT_CONFIG.emptyWindowMinutes,
    btbDurationMinutes: userConfig.btbDurationMinutes ?? DEFAULT_CONFIG.btbDurationMinutes,
    minGapMinutes: userConfig.minGapMinutes ?? DEFAULT_CONFIG.minGapMinutes,
  };

  // Get selected locations
  const allLocations = await getLocations();
  const locations = allLocations.filter((l) => locationIds.includes(l.id));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const datesToProcess: string[] = [];
  for (let i = 0; i < settings.lookAheadDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    datesToProcess.push(d.toISOString().split("T")[0]);
  }

  // Set up SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
      };

      send({ type: "start", total: locations.length, dates: datesToProcess.length });

      for (let locIndex = 0; locIndex < locations.length; locIndex++) {
        const location = locations[locIndex];
        send({
          type: "location-start",
          index: locIndex,
          name: location.name,
          progress: Math.round((locIndex / locations.length) * 100)
        });

        const locationResult = {
          location: location.name,
          added: [] as string[],
          skipped: 0,
          errors: [] as string[],
        };

        try {
          // Add delay between locations to avoid rate limiting
          if (locIndex > 0) await sleep(3000);

          const allTimeblocks = await withRetry(() => getTimeblocks(location.id));

          const analysisConfig: BTBCleanupConfig = {
            ...DEFAULT_BTB_CONFIG,
            utilizationThreshold: settings.utilizationThreshold,
            minGapMinutes: settings.minGapMinutes,
            emptyWindowMinutes: settings.emptyWindowMinutes,
            btbDurationMinutes: settings.btbDurationMinutes,
            lookAheadDays: settings.lookAheadDays,
          };

          for (let dateIndex = 0; dateIndex < datesToProcess.length; dateIndex++) {
            const date = datesToProcess[dateIndex];
            try {
              // Add delay between dates
              if (dateIndex > 0) await sleep(300);

              // Sequential to avoid rate limiting
              const shifts = await withRetry(() => getShifts(location.id, date, date));
              await sleep(200);
              const appointments = await withRetry(() => getAppointments(location.id, date, date));

              if (shifts.length === 0) continue;

              const dateTimeblocks = allTimeblocks.filter((tb) => tb.startAt.includes(date));

              for (const shift of shifts) {
                const shiftStart = new Date(shift.startAt);
                const shiftEnd = new Date(shift.endAt);
                const shiftDurationHours = (shiftEnd.getTime() - shiftStart.getTime()) / (1000 * 60 * 60);

                if (shiftDurationHours < settings.minShiftHours) continue;

                const analysis = analyzeBTBBlocks(shift, appointments, dateTimeblocks, analysisConfig);
                const staffName = shift.staffMember.displayName || shift.staffMember.name;

                if (!analysis.startBlockShouldAdd && !analysis.endBlockShouldAdd) continue;

                if (dryRun) {
                  const staffId = shift.staffMember.id.replace("urn:blvd:Staff:", "");
                  const wouldOverlap = (proposedStart: Date, durationMin: number): boolean => {
                    const proposedEnd = proposedStart.getTime() + durationMin * 60 * 1000;
                    return allTimeblocks.some((tb) => {
                      const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
                      if (tbStaffId !== staffId) return false;
                      const tbStart = new Date(tb.startAt).getTime();
                      const tbEnd = new Date(tb.endAt).getTime();
                      return proposedStart.getTime() < tbEnd && proposedEnd > tbStart;
                    });
                  };

                  if (analysis.startBlockShouldAdd) {
                    if (wouldOverlap(shiftStart, settings.btbDurationMinutes)) {
                      locationResult.skipped++;
                    } else {
                      locationResult.added.push(`${date} ${staffName}: start BTB`);
                    }
                  }
                  if (analysis.endBlockShouldAdd) {
                    const startTime = new Date(shiftEnd.getTime() - settings.btbDurationMinutes * 60 * 1000);
                    if (wouldOverlap(startTime, settings.btbDurationMinutes)) {
                      locationResult.skipped++;
                    } else {
                      locationResult.added.push(`${date} ${staffName}: end BTB`);
                    }
                  }
                } else {
                  const result = await executeBTBActions(analysis, analysisConfig, allTimeblocks);
                  for (const added of result.added) {
                    locationResult.added.push(`${date}: ${added}`);
                  }
                  for (const err of result.errors) {
                    locationResult.errors.push(`${date}: ${err}`);
                  }
                  const recommended = (analysis.startBlockShouldAdd ? 1 : 0) + (analysis.endBlockShouldAdd ? 1 : 0);
                  locationResult.skipped += recommended - result.added.length;
                }
              }
            } catch (e: any) {
              const errMsg = e.message || "Unknown error";
              // Extract the short rate limit message or use full error
              if (errMsg.includes("API limit")) {
                const waitMatch = errMsg.match(/wait (\d+)ms/);
                const waitInfo = waitMatch ? ` (needs ${waitMatch[1]}ms)` : "";
                locationResult.errors.push(`${date}: Rate limited${waitInfo} after 10 retries`);
              } else {
                locationResult.errors.push(`${date}: ${errMsg.substring(0, 100)}`);
              }
            }
          }
        } catch (e: any) {
          locationResult.errors.push(`Failed to fetch data: ${e.message}`);
        }

        send({
          type: "location-complete",
          index: locIndex,
          name: location.name,
          result: locationResult,
          progress: Math.round(((locIndex + 1) / locations.length) * 100)
        });

        // Log to changelog (only if there were changes or errors)
        if (locationResult.added.length > 0 || locationResult.errors.length > 0) {
          logChange({
            action: "bootstrap",
            mode: dryRun ? "dry-run" : "execute",
            location: location.name,
            details: locationResult.errors.length > 0
              ? locationResult.errors.slice(0, 10)
              : locationResult.added.slice(0, 20),
            added: locationResult.added.length,
            skipped: locationResult.skipped,
            errors: locationResult.errors.length,
          });
        }
      }

      send({ type: "complete" });
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// API: Run BTB bootstrap for selected locations (non-streaming fallback)
app.post("/api/btb/bootstrap", async (c) => {
  try {
    const body = await c.req.json();
    const { locationIds, dryRun = true, config: userConfig = {} } = body;

    if (!locationIds || !Array.isArray(locationIds) || locationIds.length === 0) {
      return c.json({ error: "No locations selected" }, 400);
    }

    // Merge user config with defaults
    const settings = {
      lookAheadDays: userConfig.lookAheadDays ?? DEFAULT_CONFIG.lookAheadDays,
      minShiftHours: userConfig.minShiftHours ?? DEFAULT_CONFIG.minShiftHours,
      utilizationThreshold: userConfig.utilizationThreshold ?? DEFAULT_CONFIG.utilizationThreshold,
      emptyWindowMinutes: userConfig.emptyWindowMinutes ?? DEFAULT_CONFIG.emptyWindowMinutes,
      btbDurationMinutes: userConfig.btbDurationMinutes ?? DEFAULT_CONFIG.btbDurationMinutes,
      minGapMinutes: userConfig.minGapMinutes ?? DEFAULT_CONFIG.minGapMinutes,
    };

    // Get selected locations
    const allLocations = await getLocations();
    const locations = allLocations.filter((l) => locationIds.includes(l.id));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Generate days based on config
    const datesToProcess: string[] = [];
    for (let i = 0; i < settings.lookAheadDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      datesToProcess.push(d.toISOString().split("T")[0]);
    }

    const results: {
      location: string;
      added: string[];
      skipped: number;
      errors: string[];
    }[] = [];

    for (let locIndex = 0; locIndex < locations.length; locIndex++) {
      const location = locations[locIndex];
      const locationResult = {
        location: location.name,
        added: [] as string[],
        skipped: 0,
        errors: [] as string[],
      };

      try {
        // Add delay between locations
        if (locIndex > 0) await sleep(3000);

        // Get all timeblocks for overlap detection
        const allTimeblocks = await withRetry(() => getTimeblocks(location.id));

        for (let dateIndex = 0; dateIndex < datesToProcess.length; dateIndex++) {
          const date = datesToProcess[dateIndex];
          try {
            // Add delay between dates
            if (dateIndex > 0) await sleep(300);

            const [shifts, appointments] = await Promise.all([
              withRetry(() => getShifts(location.id, date, date)),
              withRetry(() => getAppointments(location.id, date, date)),
            ]);

            if (shifts.length === 0) continue;

            const dateTimeblocks = allTimeblocks.filter((tb) => tb.startAt.includes(date));

            // Build config for analyzeBTBBlocks
            const analysisConfig: BTBCleanupConfig = {
              ...DEFAULT_BTB_CONFIG,
              utilizationThreshold: settings.utilizationThreshold,
              minGapMinutes: settings.minGapMinutes,
              emptyWindowMinutes: settings.emptyWindowMinutes,
              btbDurationMinutes: settings.btbDurationMinutes,
              lookAheadDays: settings.lookAheadDays,
            };

            for (const shift of shifts) {
              // Skip short shifts based on config
              const shiftStart = new Date(shift.startAt);
              const shiftEnd = new Date(shift.endAt);
              const shiftDurationHours = (shiftEnd.getTime() - shiftStart.getTime()) / (1000 * 60 * 60);

              if (shiftDurationHours < settings.minShiftHours) {
                continue;
              }

              const analysis = analyzeBTBBlocks(shift, appointments, dateTimeblocks, analysisConfig);
              const staffName = shift.staffMember.displayName || shift.staffMember.name;

              if (!analysis.startBlockShouldAdd && !analysis.endBlockShouldAdd) continue;

              if (dryRun) {
                // Check overlaps for accurate dry-run counts
                const staffId = shift.staffMember.id.replace("urn:blvd:Staff:", "");
                const wouldOverlap = (proposedStart: Date, durationMin: number): boolean => {
                  const proposedEnd = proposedStart.getTime() + durationMin * 60 * 1000;
                  return allTimeblocks.some((tb) => {
                    const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
                    if (tbStaffId !== staffId) return false;
                    const tbStart = new Date(tb.startAt).getTime();
                    const tbEnd = new Date(tb.endAt).getTime();
                    return proposedStart.getTime() < tbEnd && proposedEnd > tbStart;
                  });
                };

                if (analysis.startBlockShouldAdd) {
                  if (wouldOverlap(shiftStart, settings.btbDurationMinutes)) {
                    locationResult.skipped++;
                  } else {
                    locationResult.added.push(`${date} ${staffName}: start BTB`);
                  }
                }
                if (analysis.endBlockShouldAdd) {
                  const startTime = new Date(shiftEnd.getTime() - settings.btbDurationMinutes * 60 * 1000);
                  if (wouldOverlap(startTime, settings.btbDurationMinutes)) {
                    locationResult.skipped++;
                  } else {
                    locationResult.added.push(`${date} ${staffName}: end BTB`);
                  }
                }
              } else {
                const result = await executeBTBActions(analysis, analysisConfig, allTimeblocks);
                for (const added of result.added) {
                  locationResult.added.push(`${date}: ${added}`);
                }
                for (const err of result.errors) {
                  locationResult.errors.push(`${date}: ${err}`);
                }
                const recommended = (analysis.startBlockShouldAdd ? 1 : 0) + (analysis.endBlockShouldAdd ? 1 : 0);
                locationResult.skipped += recommended - result.added.length;
              }
            }
          } catch (e: any) {
            if (e.message?.includes("API limit")) {
              locationResult.errors.push(`${date}: Rate limited`);
            } else {
              locationResult.errors.push(`${date}: ${e.message}`);
            }
          }
        }
      } catch (e: any) {
        locationResult.errors.push(`Failed to fetch data: ${e.message}`);
      }

      results.push(locationResult);
    }

    return c.json({
      mode: dryRun ? "dry-run" : "execute",
      dates: `${datesToProcess[0]} to ${datesToProcess[datesToProcess.length - 1]}`,
      results,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// BTB Admin UI page
app.get("/", (c) => c.redirect("/btb-admin"));

app.get("/btb-admin", (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BTB Manager | Hello Sugar</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --black: #0a0a0a;
      --white: #ffffff;
      --red: #e63946;
      --red-dark: #c1121f;
      --gray-100: #f8f8f8;
      --gray-200: #e5e5e5;
      --gray-300: #d4d4d4;
      --gray-400: #a3a3a3;
      --gray-500: #737373;
      --gray-600: #525252;
      --gray-700: #404040;
      --gray-800: #262626;
      --gray-900: #171717;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--black);
      color: var(--white);
      min-height: 100vh;
      line-height: 1.5;
    }

    /* Header */
    .header {
      padding: 24px 40px;
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .logo {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 28px;
      letter-spacing: 2px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      width: 40px;
      height: 40px;
      background: var(--red);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .badge {
      background: var(--gray-800);
      color: var(--gray-400);
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 1px;
      padding: 6px 12px;
      text-transform: uppercase;
    }

    /* Main Layout */
    .main {
      display: grid;
      grid-template-columns: 1fr 380px;
      min-height: calc(100vh - 89px);
    }

    /* Locations Panel */
    .locations-panel {
      padding: 32px 40px;
      border-right: 1px solid var(--gray-800);
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    .panel-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 24px;
      letter-spacing: 1px;
    }

    .search-box {
      position: relative;
      margin-bottom: 20px;
    }

    .search-box input {
      width: 100%;
      background: var(--gray-900);
      border: 1px solid var(--gray-800);
      color: var(--white);
      padding: 14px 16px 14px 44px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }

    .search-box input:focus {
      border-color: var(--gray-600);
    }

    .search-box input::placeholder {
      color: var(--gray-500);
    }

    .search-box svg {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--gray-500);
    }

    .select-controls {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--gray-800);
    }

    .select-all-btn {
      background: none;
      border: 1px solid var(--gray-700);
      color: var(--white);
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .select-all-btn:hover {
      background: var(--gray-800);
      border-color: var(--gray-600);
    }

    .selected-count {
      color: var(--red);
      font-weight: 600;
      font-size: 14px;
    }

    .locations-grid {
      flex: 1;
      overflow-y: auto;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 8px;
      align-content: start;
      padding-right: 8px;
    }

    .locations-grid::-webkit-scrollbar {
      width: 6px;
    }

    .locations-grid::-webkit-scrollbar-track {
      background: var(--gray-900);
    }

    .locations-grid::-webkit-scrollbar-thumb {
      background: var(--gray-700);
    }

    .location {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      background: var(--gray-900);
      border: 1px solid var(--gray-800);
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
      overflow: hidden;
    }

    .location::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--red);
      transform: scaleY(0);
      transition: transform 0.15s ease;
    }

    .location:hover {
      background: var(--gray-800);
      border-color: var(--gray-700);
    }

    .location.selected {
      background: var(--gray-800);
      border-color: var(--red);
    }

    .location.selected::before {
      transform: scaleY(1);
    }

    .checkbox {
      width: 18px;
      height: 18px;
      border: 2px solid var(--gray-600);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
    }

    .location.selected .checkbox {
      background: var(--red);
      border-color: var(--red);
    }

    .checkbox svg {
      opacity: 0;
      transform: scale(0.5);
      transition: all 0.15s;
    }

    .location.selected .checkbox svg {
      opacity: 1;
      transform: scale(1);
    }

    .location-name {
      font-size: 13px;
      color: var(--gray-200);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }

    .location.selected .location-name {
      color: var(--white);
    }

    .enrolled-badge {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 6px;
      background: var(--gray-700);
      color: var(--gray-300);
      flex-shrink: 0;
    }

    .location.enrolled .enrolled-badge {
      background: var(--red);
      color: var(--white);
    }

    /* Actions Panel */
    .actions-panel {
      padding: 32px;
      display: flex;
      flex-direction: column;
      background: var(--gray-900);
    }

    .action-section {
      margin-bottom: 32px;
    }

    .section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gray-500);
      margin-bottom: 16px;
    }

    .config-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .config-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .config-item label {
      font-size: 11px;
      color: var(--gray-400);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .config-item input {
      background: var(--black);
      border: 1px solid var(--gray-700);
      color: var(--white);
      padding: 10px 12px;
      font-size: 14px;
      font-weight: 600;
      outline: none;
      transition: border-color 0.2s;
      -moz-appearance: textfield;
    }

    .config-item input::-webkit-outer-spin-button,
    .config-item input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .config-item input:focus {
      border-color: var(--red);
    }

    .info-card {
      background: var(--black);
      border: 1px solid var(--gray-800);
      padding: 16px 20px;
    }

    .info-card ul {
      list-style: none;
      font-size: 13px;
      color: var(--gray-400);
    }

    .info-card li {
      padding: 5px 0;
      padding-left: 20px;
      position: relative;
    }

    .info-card li::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      width: 6px;
      height: 6px;
      background: var(--red);
      transform: translateY(-50%);
    }

    .info-card strong {
      color: var(--white);
    }

    .action-buttons {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: auto;
    }

    .btn {
      padding: 16px 24px;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-outline {
      background: transparent;
      border: 2px solid var(--gray-600);
      color: var(--white);
    }

    .btn-outline:hover:not(:disabled) {
      border-color: var(--white);
      background: var(--gray-800);
    }

    .btn-primary {
      background: var(--red);
      color: var(--white);
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--red-dark);
    }

    .btn-enroll {
      background: transparent;
      border: 2px solid #22c55e;
      color: #22c55e;
    }

    .btn-enroll:hover:not(:disabled) {
      background: rgba(34, 197, 94, 0.1);
    }

    .btn-unenroll {
      background: transparent;
      border: 2px solid var(--gray-600);
      color: var(--gray-400);
    }

    .btn-unenroll:hover:not(:disabled) {
      background: var(--gray-800);
      border-color: var(--gray-500);
    }

    .divider {
      height: 1px;
      background: var(--gray-800);
      margin: 8px 0;
    }

    .enrollment-info {
      margin-top: 16px;
      padding: 12px;
      background: var(--black);
      border: 1px solid var(--gray-800);
      font-size: 12px;
      color: var(--gray-400);
      text-align: center;
    }

    .enrollment-info #enrolledCount {
      color: var(--red);
      font-weight: 600;
    }

    /* Tabs */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--gray-800);
    }

    .tab {
      padding: 16px 24px;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gray-500);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.2s;
    }

    .tab:hover {
      color: var(--gray-300);
    }

    .tab.active {
      color: var(--white);
      border-bottom-color: var(--red);
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* Changelog */
    .changelog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 0;
      border-bottom: 1px solid var(--gray-800);
      margin-bottom: 20px;
    }

    .changelog-count {
      font-size: 14px;
      color: var(--gray-400);
    }

    .changelog-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .changelog-entry {
      background: var(--gray-900);
      border: 1px solid var(--gray-800);
      padding: 16px;
    }

    .changelog-entry-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }

    .changelog-entry-time {
      font-size: 12px;
      color: var(--gray-500);
    }

    .changelog-entry-mode {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 8px;
    }

    .changelog-entry-mode.execute {
      background: var(--red);
      color: var(--white);
    }

    .changelog-entry-mode.dry-run {
      background: var(--gray-700);
      color: var(--gray-300);
    }

    .changelog-entry-location {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 8px;
    }

    .changelog-entry-stats {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--gray-400);
    }

    .changelog-entry-stats .added { color: #22c55e; }
    .changelog-entry-stats .skipped { color: #eab308; }
    .changelog-entry-stats .errors { color: var(--red); }

    .changelog-entry-details {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--gray-800);
      font-size: 12px;
      color: var(--gray-500);
      font-family: 'SF Mono', 'Consolas', monospace;
      max-height: 100px;
      overflow-y: auto;
    }

    .changelog-entry-details div {
      padding: 2px 0;
    }

    .changelog-empty {
      text-align: center;
      padding: 60px 20px;
      color: var(--gray-500);
    }

    /* Progress Panel */
    .progress-panel {
      position: fixed;
      inset: 0;
      background: var(--black);
      z-index: 100;
      display: none;
      flex-direction: column;
    }

    .progress-panel.active {
      display: flex;
    }

    .progress-header {
      padding: 24px 40px;
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .progress-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 28px;
      letter-spacing: 1px;
    }

    .progress-bar-container {
      padding: 24px 40px;
      background: var(--gray-900);
      border-bottom: 1px solid var(--gray-800);
    }

    .progress-bar-wrapper {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .progress-bar {
      flex: 1;
      height: 8px;
      background: var(--gray-800);
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background: var(--red);
      width: 0%;
      transition: width 0.3s ease;
    }

    .progress-percent {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 24px;
      min-width: 60px;
      text-align: right;
    }

    .progress-status {
      margin-top: 12px;
      font-size: 13px;
      color: var(--gray-400);
    }

    .progress-status strong {
      color: var(--white);
    }

    .progress-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 40px;
    }

    .progress-item {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 16px 0;
      border-bottom: 1px solid var(--gray-800);
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .progress-item-status {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .progress-item-status.pending {
      color: var(--gray-600);
    }

    .progress-item-status.loading .mini-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--gray-700);
      border-top-color: var(--red);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    .progress-item-status.success {
      color: #22c55e;
    }

    .progress-item-status.error {
      color: var(--red);
    }

    .progress-item-content {
      flex: 1;
      min-width: 0;
    }

    .progress-item-name {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
    }

    .progress-item-detail {
      font-size: 12px;
      color: var(--gray-400);
    }

    .progress-item-detail .added {
      color: #22c55e;
    }

    .progress-item-detail .skipped {
      color: #eab308;
    }

    .progress-item-detail .errors {
      color: var(--red);
    }

    .progress-item-list {
      margin-top: 8px;
      font-size: 12px;
      color: var(--gray-500);
      max-height: 100px;
      overflow-y: auto;
      font-family: 'SF Mono', 'Consolas', monospace;
    }

    .progress-item-list div {
      padding: 2px 0;
    }

    .progress-footer {
      padding: 20px 40px;
      border-top: 1px solid var(--gray-800);
      display: flex;
      justify-content: flex-end;
    }

    .spinner {
      width: 48px;
      height: 48px;
      border: 3px solid var(--gray-800);
      border-top-color: var(--red);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Results Panel */
    .results-panel {
      position: fixed;
      inset: 0;
      background: var(--black);
      z-index: 50;
      display: none;
      flex-direction: column;
      animation: slideUp 0.3s ease;
    }

    .results-panel.active {
      display: flex;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .results-header {
      padding: 24px 40px;
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .results-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 28px;
      letter-spacing: 1px;
    }

    .close-btn {
      background: none;
      border: 1px solid var(--gray-700);
      color: var(--white);
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    .close-btn:hover {
      background: var(--gray-800);
      border-color: var(--gray-600);
    }

    .results-summary {
      padding: 24px 40px;
      background: var(--gray-900);
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      gap: 40px;
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stat-value {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 36px;
      letter-spacing: 1px;
      line-height: 1;
    }

    .stat-value.success { color: #22c55e; }
    .stat-value.warning { color: #eab308; }
    .stat-value.error { color: var(--red); }

    .stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--gray-500);
    }

    .results-content {
      flex: 1;
      overflow-y: auto;
      padding: 32px 40px;
    }

    .result-item {
      background: var(--gray-900);
      border: 1px solid var(--gray-800);
      margin-bottom: 16px;
    }

    .result-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .result-location {
      font-weight: 600;
      font-size: 14px;
    }

    .result-count {
      font-size: 12px;
      color: var(--gray-400);
    }

    .result-list {
      list-style: none;
      max-height: 200px;
      overflow-y: auto;
    }

    .result-list li {
      padding: 10px 20px;
      font-size: 13px;
      color: var(--gray-300);
      border-bottom: 1px solid var(--gray-800);
      font-family: 'SF Mono', 'Consolas', monospace;
    }

    .result-list li:last-child {
      border-bottom: none;
    }

    .result-list li.error {
      color: var(--red);
    }

    .no-results {
      color: var(--gray-500);
      padding: 20px;
      font-size: 14px;
    }

    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      color: var(--gray-500);
    }

    .empty-state svg {
      margin-bottom: 16px;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="logo">
      <div class="logo-icon">HS</div>
      <span>HELLO SUGAR</span>
    </div>
    <div class="badge">BTB Manager</div>
  </header>

  <main class="main">
    <section class="locations-panel">
      <div class="tabs">
        <div class="tab active" data-tab="locations">Locations</div>
        <div class="tab" data-tab="changelog">Changelog</div>
      </div>

      <div class="tab-content active" id="tab-locations">
      <div class="panel-header" style="padding-top: 24px;">
        <h1 class="panel-title">SELECT LOCATIONS</h1>
      </div>

      <div class="search-box">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
        <input type="text" id="searchInput" placeholder="Search locations...">
      </div>

      <div class="select-controls">
        <button class="select-all-btn" id="selectAllBtn">Select All</button>
        <button class="select-all-btn" id="clearAllBtn">Clear</button>
        <button class="select-all-btn" id="selectEnrolledBtn">Select Enrolled</button>
        <span class="selected-count" id="selectedCount">0 selected</span>
      </div>

      <div class="locations-grid" id="locations">
        <div class="empty-state" id="loadingLocations">
          <div class="spinner"></div>
        </div>
      </div>
      </div>

      <div class="tab-content" id="tab-changelog" style="padding: 0 40px 32px 40px;">
        <div class="changelog-header">
          <span class="changelog-count" id="changelogCount">0 entries</span>
          <button class="select-all-btn" id="clearChangelogBtn">Clear All</button>
        </div>
        <div class="changelog-list" id="changelogList">
          <div class="changelog-empty">No changes recorded yet</div>
        </div>
      </div>
    </section>

    <aside class="actions-panel">
      <div class="action-section">
        <div class="section-label">Configuration</div>
        <div class="config-grid">
          <div class="config-item">
            <label for="lookAheadDays">Days Ahead</label>
            <input type="number" id="lookAheadDays" value="14" min="1" max="30">
          </div>
          <div class="config-item">
            <label for="minShiftHours">Min Shift (hrs)</label>
            <input type="number" id="minShiftHours" value="4" min="1" max="12">
          </div>
          <div class="config-item">
            <label for="utilizationThreshold">Max Utilization %</label>
            <input type="number" id="utilizationThreshold" value="50" min="0" max="100">
          </div>
          <div class="config-item">
            <label for="emptyWindowMinutes">Empty Window (min)</label>
            <input type="number" id="emptyWindowMinutes" value="120" min="30" max="240">
          </div>
          <div class="config-item">
            <label for="btbDurationMinutes">BTB Duration (min)</label>
            <input type="number" id="btbDurationMinutes" value="60" min="15" max="120">
          </div>
        </div>
      </div>

      <div class="action-section">
        <div class="section-label">Rules Applied</div>
        <div class="info-card">
          <ul id="rulesDisplay">
            <li>Shifts at least <strong>4 hours</strong> long</li>
            <li>Utilization below <strong>50%</strong></li>
            <li>No appointments in first/last <strong>2 hours</strong></li>
            <li>No existing blocks that would overlap</li>
          </ul>
        </div>
      </div>

      <div class="action-buttons">
        <button class="btn btn-outline" id="dryRunBtn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          Preview Changes
        </button>
        <button class="btn btn-primary" id="executeBtn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14"/>
            <path d="m12 5 7 7-7 7"/>
          </svg>
          Execute Bootstrap
        </button>
        <div class="divider"></div>
        <button class="btn btn-enroll" id="enrollBtn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14"/>
            <path d="M5 12h14"/>
          </svg>
          Enroll Selected
        </button>
        <button class="btn btn-unenroll" id="unenrollBtn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14"/>
          </svg>
          Unenroll Selected
        </button>
      </div>
      <div class="enrollment-info" id="enrollmentInfo">
        <span id="enrolledCount">0</span> locations enrolled for daily automation
      </div>
    </aside>
  </main>

  <div class="progress-panel" id="progressPanel">
    <header class="progress-header">
      <h2 class="progress-title" id="progressTitle">PROCESSING</h2>
    </header>
    <div class="progress-bar-container">
      <div class="progress-bar-wrapper">
        <div class="progress-bar">
          <div class="progress-bar-fill" id="progressBarFill"></div>
        </div>
        <div class="progress-percent" id="progressPercent">0%</div>
      </div>
      <div class="progress-status" id="progressStatus">Initializing...</div>
    </div>
    <div class="progress-content" id="progressContent"></div>
    <div class="progress-footer">
      <button class="btn btn-outline" id="closeProgress" style="display: none;">Close</button>
    </div>
  </div>

  <div class="results-panel" id="resultsPanel">
    <header class="results-header">
      <h2 class="results-title" id="resultsTitle">RESULTS</h2>
      <button class="close-btn" id="closeResults">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6 6 18"/>
          <path d="m6 6 12 12"/>
        </svg>
      </button>
    </header>
    <div class="results-summary" id="resultsSummary"></div>
    <div class="results-content" id="resultsContent"></div>
  </div>

  <script>
    let locations = [];
    let filteredLocations = [];
    let selectedLocations = new Set();
    let enrolledLocations = new Set();

    async function loadLocations() {
      try {
        const [locRes, enrollRes] = await Promise.all([
          fetch('/api/locations'),
          fetch('/api/enrollment')
        ]);
        const locData = await locRes.json();
        const enrollData = await enrollRes.json();

        locations = (locData.locations || []).sort((a, b) => a.name.localeCompare(b.name));
        filteredLocations = locations;
        enrolledLocations = new Set(enrollData.locations || []);

        renderLocations();
        updateEnrollmentInfo();
      } catch (e) {
        document.getElementById('locations').innerHTML = '<div class="empty-state">Failed to load locations</div>';
      }
    }

    function updateEnrollmentInfo() {
      document.getElementById('enrolledCount').textContent = enrolledLocations.size;
    }

    function renderLocations() {
      const container = document.getElementById('locations');

      if (filteredLocations.length === 0) {
        container.innerHTML = '<div class="empty-state">No locations found</div>';
        return;
      }

      container.innerHTML = filteredLocations.map(loc => {
        const isSelected = selectedLocations.has(loc.id);
        const isEnrolled = enrolledLocations.has(loc.id);
        return \`
          <div class="location \${isSelected ? 'selected' : ''} \${isEnrolled ? 'enrolled' : ''}" data-id="\${loc.id}">
            <div class="checkbox">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <span class="location-name">\${loc.name}</span>
            <span class="enrolled-badge">\${isEnrolled ? 'ENROLLED' : ''}</span>
          </div>
        \`;
      }).join('');

      container.querySelectorAll('.location').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.id;
          if (selectedLocations.has(id)) {
            selectedLocations.delete(id);
          } else {
            selectedLocations.add(id);
          }
          el.classList.toggle('selected');
          updateUI();
        });
      });
    }

    function updateUI() {
      const hasSelection = selectedLocations.size > 0;
      document.getElementById('dryRunBtn').disabled = !hasSelection;
      document.getElementById('executeBtn').disabled = !hasSelection;
      document.getElementById('enrollBtn').disabled = !hasSelection;
      document.getElementById('unenrollBtn').disabled = !hasSelection;
      document.getElementById('selectedCount').textContent = selectedLocations.size + ' selected';
    }

    document.getElementById('searchInput').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      filteredLocations = locations.filter(loc => loc.name.toLowerCase().includes(query));
      renderLocations();
    });

    document.getElementById('selectAllBtn').addEventListener('click', () => {
      filteredLocations.forEach(loc => selectedLocations.add(loc.id));
      renderLocations();
      updateUI();
    });

    document.getElementById('clearAllBtn').addEventListener('click', () => {
      selectedLocations.clear();
      renderLocations();
      updateUI();
    });

    function getConfig() {
      return {
        lookAheadDays: parseInt(document.getElementById('lookAheadDays').value) || 14,
        minShiftHours: parseInt(document.getElementById('minShiftHours').value) || 4,
        utilizationThreshold: parseInt(document.getElementById('utilizationThreshold').value) || 50,
        emptyWindowMinutes: parseInt(document.getElementById('emptyWindowMinutes').value) || 120,
        btbDurationMinutes: parseInt(document.getElementById('btbDurationMinutes').value) || 60,
      };
    }

    function updateRulesDisplay() {
      const config = getConfig();
      const hours = Math.floor(config.emptyWindowMinutes / 60);
      const mins = config.emptyWindowMinutes % 60;
      const windowText = mins > 0 ? \`\${hours}h \${mins}m\` : \`\${hours} hours\`;

      document.getElementById('rulesDisplay').innerHTML = \`
        <li>Shifts at least <strong>\${config.minShiftHours} hours</strong> long</li>
        <li>Utilization below <strong>\${config.utilizationThreshold}%</strong></li>
        <li>No appointments in first/last <strong>\${windowText}</strong></li>
        <li>No existing blocks that would overlap</li>
      \`;
    }

    // Update rules when config changes
    document.querySelectorAll('.config-item input').forEach(input => {
      input.addEventListener('input', updateRulesDisplay);
    });

    async function runBootstrap(dryRun) {
      const panel = document.getElementById('progressPanel');
      const title = document.getElementById('progressTitle');
      const barFill = document.getElementById('progressBarFill');
      const percent = document.getElementById('progressPercent');
      const progressStatus = document.getElementById('progressStatus');
      const progressContent = document.getElementById('progressContent');
      const closeBtn = document.getElementById('closeProgress');
      const config = getConfig();

      // Reset and show progress panel
      panel.classList.add('active');
      title.textContent = dryRun ? 'ANALYZING' : 'EXECUTING';
      barFill.style.width = '0%';
      percent.textContent = '0%';
      progressStatus.innerHTML = 'Connecting...';
      progressContent.innerHTML = '';
      closeBtn.style.display = 'none';

      let totalAdded = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      try {
        const res = await fetch('/api/btb/bootstrap-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locationIds: Array.from(selectedLocations),
            dryRun,
            config,
          }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'start') {
                progressStatus.innerHTML = 'Processing <strong>' + data.total + '</strong> locations over <strong>' + data.dates + '</strong> days';
              }

              if (data.type === 'location-start') {
                const item = document.createElement('div');
                item.className = 'progress-item';
                item.id = 'progress-item-' + data.index;
                item.innerHTML = '<div class="progress-item-status loading"><div class="mini-spinner"></div></div><div class="progress-item-content"><div class="progress-item-name">' + data.name + '</div><div class="progress-item-detail">Analyzing...</div></div>';
                progressContent.insertBefore(item, progressContent.firstChild);
                barFill.style.width = data.progress + '%';
                percent.textContent = data.progress + '%';
              }

              if (data.type === 'location-complete') {
                const item = document.getElementById('progress-item-' + data.index);
                const r = data.result;
                totalAdded += r.added.length;
                totalSkipped += r.skipped;
                totalErrors += r.errors.length;

                const hasErrors = r.errors.length > 0;
                const statusClass = hasErrors ? 'error' : 'success';
                const statusIcon = hasErrors
                  ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>'
                  : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

                let detail = '';
                if (r.added.length > 0) detail += '<span class="added">' + r.added.length + (dryRun ? ' to add' : ' added') + '</span> ';
                if (r.skipped > 0) detail += '<span class="skipped">' + r.skipped + ' skipped</span> ';
                if (r.errors.length > 0) detail += '<span class="errors">' + r.errors.length + ' errors</span>';
                if (!detail) detail = 'No changes needed';

                let listHtml = '';
                if (r.added.length > 0) {
                  listHtml = r.added.slice(0, 5).map(function(a) { return '<div>' + a + '</div>'; }).join('');
                  if (r.added.length > 5) listHtml += '<div>... and ' + (r.added.length - 5) + ' more</div>';
                }

                item.innerHTML = '<div class="progress-item-status ' + statusClass + '">' + statusIcon + '</div><div class="progress-item-content"><div class="progress-item-name">' + r.location + '</div><div class="progress-item-detail">' + detail + '</div>' + (listHtml ? '<div class="progress-item-list">' + listHtml + '</div>' : '') + '</div>';
                barFill.style.width = data.progress + '%';
                percent.textContent = data.progress + '%';
              }

              if (data.type === 'complete') {
                progressStatus.innerHTML = 'Complete! <span class="added">' + totalAdded + (dryRun ? ' to add' : ' added') + '</span>, <span class="skipped">' + totalSkipped + ' skipped</span>' + (totalErrors > 0 ? ', <span class="errors">' + totalErrors + ' errors</span>' : '');
                closeBtn.style.display = 'block';
              }
            }
          }
        }
      } catch (e) {
        progressStatus.innerHTML = '<span class="errors">Error: ' + e.message + '</span>';
        closeBtn.style.display = 'block';
      }
    }

    document.getElementById('closeProgress').addEventListener('click', function() {
      document.getElementById('progressPanel').classList.remove('active');
      updateButtons();
    });

    function displayResults(data, dryRun) {
      const panel = document.getElementById('resultsPanel');
      const title = document.getElementById('resultsTitle');
      const summary = document.getElementById('resultsSummary');
      const content = document.getElementById('resultsContent');

      let totalAdded = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      data.results.forEach(r => {
        totalAdded += r.added.length;
        totalSkipped += r.skipped;
        totalErrors += r.errors.length;
      });

      title.textContent = dryRun ? 'PREVIEW RESULTS' : 'EXECUTION COMPLETE';

      summary.innerHTML = \`
        <div class="stat">
          <div class="stat-value success">\${totalAdded}</div>
          <div class="stat-label">\${dryRun ? 'Would Add' : 'Added'}</div>
        </div>
        <div class="stat">
          <div class="stat-value warning">\${totalSkipped}</div>
          <div class="stat-label">Skipped (Overlap)</div>
        </div>
        \${totalErrors > 0 ? \`
          <div class="stat">
            <div class="stat-value error">\${totalErrors}</div>
            <div class="stat-label">Errors</div>
          </div>
        \` : ''}
        <div class="stat">
          <div class="stat-value">\${data.results.length}</div>
          <div class="stat-label">Locations</div>
        </div>
      \`;

      content.innerHTML = data.results.map(r => \`
        <div class="result-item">
          <div class="result-header">
            <span class="result-location">\${r.location}</span>
            <span class="result-count">\${r.added.length} blocks</span>
          </div>
          \${r.added.length > 0 ? \`
            <ul class="result-list">
              \${r.added.map(a => \`<li>\${a}</li>\`).join('')}
            </ul>
          \` : '<div class="no-results">No blocks to add</div>'}
          \${r.errors.length > 0 ? \`
            <ul class="result-list">
              \${r.errors.map(e => \`<li class="error">\${e}</li>\`).join('')}
            </ul>
          \` : ''}
        </div>
      \`).join('');

      panel.classList.add('active');
    }

    document.getElementById('closeResults').addEventListener('click', () => {
      document.getElementById('resultsPanel').classList.remove('active');
    });

    document.getElementById('dryRunBtn').addEventListener('click', () => runBootstrap(true));
    document.getElementById('executeBtn').addEventListener('click', () => {
      if (confirm('This will add BTB blocks to Boulevard. Continue?')) {
        runBootstrap(false);
      }
    });

    document.getElementById('selectEnrolledBtn').addEventListener('click', () => {
      enrolledLocations.forEach(id => selectedLocations.add(id));
      renderLocations();
      updateUI();
    });

    document.getElementById('enrollBtn').addEventListener('click', async () => {
      const ids = Array.from(selectedLocations);
      try {
        const res = await fetch('/api/enrollment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locationIds: ids, action: 'add' }),
        });
        if (res.ok) {
          ids.forEach(id => enrolledLocations.add(id));
          renderLocations();
          updateEnrollmentInfo();
        }
      } catch (e) {
        alert('Failed to enroll locations');
      }
    });

    document.getElementById('unenrollBtn').addEventListener('click', async () => {
      const ids = Array.from(selectedLocations);
      try {
        const res = await fetch('/api/enrollment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locationIds: ids, action: 'remove' }),
        });
        if (res.ok) {
          ids.forEach(id => enrolledLocations.delete(id));
          renderLocations();
          updateEnrollmentInfo();
        }
      } catch (e) {
        alert('Failed to unenroll locations');
      }
    });

    // Tabs
    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'changelog') {
          loadChangelog();
        }
      });
    });

    async function loadChangelog() {
      try {
        const res = await fetch('/api/changelog?limit=100');
        const data = await res.json();
        renderChangelog(data.entries, data.total);
      } catch (e) {
        document.getElementById('changelogList').innerHTML = '<div class="changelog-empty">Failed to load changelog</div>';
      }
    }

    function renderChangelog(entries, total) {
      const list = document.getElementById('changelogList');
      const count = document.getElementById('changelogCount');

      count.textContent = total + ' entries';

      if (entries.length === 0) {
        list.innerHTML = '<div class="changelog-empty">No changes recorded yet</div>';
        return;
      }

      list.innerHTML = entries.map(function(entry) {
        const date = new Date(entry.timestamp);
        const timeStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

        let detailsHtml = '';
        if (entry.details && entry.details.length > 0) {
          detailsHtml = '<div class="changelog-entry-details">' + entry.details.map(function(d) { return '<div>' + d + '</div>'; }).join('') + '</div>';
        }

        return '<div class="changelog-entry">' +
          '<div class="changelog-entry-header">' +
            '<span class="changelog-entry-time">' + timeStr + '</span>' +
            '<span class="changelog-entry-mode ' + entry.mode + '">' + entry.mode + '</span>' +
          '</div>' +
          '<div class="changelog-entry-location">' + entry.location + '</div>' +
          '<div class="changelog-entry-stats">' +
            '<span class="added">' + entry.added + ' added</span>' +
            '<span class="skipped">' + entry.skipped + ' skipped</span>' +
            (entry.errors > 0 ? '<span class="errors">' + entry.errors + ' errors</span>' : '') +
          '</div>' +
          detailsHtml +
        '</div>';
      }).join('');
    }

    document.getElementById('clearChangelogBtn').addEventListener('click', async function() {
      if (confirm('Clear all changelog entries?')) {
        await fetch('/api/changelog', { method: 'DELETE' });
        loadChangelog();
      }
    });

    loadLocations();
  </script>
</body>
</html>`;
  return c.html(html);
});

// ============================================
// WEBHOOK ENDPOINT FOR AUTO-CLEANUP
// ============================================

// Boulevard webhook handler for appointment events
// Only REMOVES BTB blocks when new bookings increase utilization
// Adding BTB blocks is done separately via scheduled jobs
app.post("/webhook/boulevard", async (c) => {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    console.log(`[Webhook] Received event:`, JSON.stringify(body).substring(0, 200));

    // Verify this is an appointment event
    const eventType = body?.event || body?.type;
    if (!eventType?.includes("appointment")) {
      console.log(`[Webhook] Ignored: not an appointment event (${eventType})`);
      return c.json({ status: "ignored", reason: "not an appointment event" });
    }

    // Determine if this is a cancellation (for adding BTBs) or booking (for removing BTBs)
    const isCancellation = eventType?.toLowerCase().includes("cancel");
    console.log(`[Webhook] Event type: ${eventType}, isCancellation: ${isCancellation}`);

    // Extract appointment data - Boulevard uses data.node format
    const appointment = body?.data?.node || body?.data?.appointment || body?.appointment || body?.data;
    if (!appointment) {
      console.log(`[Webhook] Ignored: no appointment data in payload`);
      return c.json({ status: "ignored", reason: "no appointment data" });
    }

    // Extract location ID - can be in multiple places
    const locationId = appointment.locationId ||
                       appointment.location?.id ||
                       appointment.location;
    if (!locationId) {
      console.log(`[Webhook] Ignored: no location ID in appointment. Keys:`, Object.keys(appointment).join(", "));
      return c.json({ status: "ignored", reason: "no location ID" });
    }

    // Check if location is enrolled
    const enrollment = readEnrollment();
    if (!enrollment.locations.includes(locationId)) {
      console.log(`[Webhook] Ignored: location ${locationId} not enrolled`);
      return c.json({ status: "ignored", reason: "location not enrolled", locationId });
    }

    // Get the staff ID from the appointment to only check their shift
    const staffId = appointment.appointmentServices?.[0]?.staff?.id ||
                    appointment.staffId ||
                    appointment.staff?.id;

    // Get config from environment or defaults
    const config: BTBCleanupConfig = {
      ...DEFAULT_BTB_CONFIG,
      utilizationThreshold: parseInt(process.env.BTB_UTILIZATION_THRESHOLD || "50"),
      minGapMinutes: parseInt(process.env.BTB_MIN_GAP_MINUTES || "60"),
      lookAheadDays: parseInt(process.env.BTB_LOOK_AHEAD_DAYS || "14"),
      emptyWindowMinutes: parseInt(process.env.BTB_EMPTY_WINDOW_MINUTES || "120"),
      btbDurationMinutes: parseInt(process.env.BTB_DURATION_MINUTES || "60"),
    };

    // Calculate date range for this appointment's day
    const appointmentDate = new Date(appointment.startAt);
    const startDate = appointmentDate.toISOString().split("T")[0];
    const endDate = startDate; // Just check this day

    console.log(`[Webhook] Processing: location=${locationId}, date=${startDate}, staff=${staffId || "all"}`);

    // Get shifts, appointments, and timeblocks for this location/day
    // Sequential to avoid rate limiting
    const shifts = await withRetry(() => getShifts(locationId, startDate, endDate, staffId ? [staffId] : undefined));
    await sleep(200);
    const appointments = await withRetry(() => getAppointments(locationId, startDate, endDate));
    await sleep(200);
    const timeblocks = await withRetry(() => getTimeblocksInRange(locationId, startDate, endDate));

    const deletedBlocks: string[] = [];
    const addedBlocks: string[] = [];
    const errors: string[] = [];

    // Get auto-add config
    const autoAddGapMinutes = parseInt(process.env.BTB_AUTO_ADD_GAP_MINUTES || "90");
    const autoAddBtbDuration = parseInt(process.env.BTB_AUTO_ADD_DURATION || "30");

    // Analyze and manage BTB blocks for each shift
    for (const shift of shifts) {
      const analysis = analyzeBTBBlocks(shift, appointments, timeblocks, config);
      const staffName = shift.staffMember.displayName || shift.staffMember.name;

      // Debug: log analysis results
      console.log(`[Webhook] Analysis for ${staffName}: util=${analysis.utilizationPercent}%, startBTB=${analysis.startBlock ? 'yes' : 'no'}, endBTB=${analysis.endBlock ? 'yes' : 'no'}, endGap=${analysis.endGapMinutes}min, shouldRemoveEnd=${analysis.endBlockShouldRemove}`);

      // REMOVAL: Remove BTB blocks when utilization is high and appointments are close
      if (analysis.startBlockShouldRemove && analysis.startBlock) {
        try {
          await deleteTimeblock(analysis.startBlock.id);
          deletedBlocks.push(
            `${staffName} start BTB (${analysis.startGapMinutes}min gap, ${analysis.utilizationPercent}% util)`
          );
          console.log(`[Webhook] Removed: ${staffName} start BTB`);
        } catch (e) {
          const errMsg = `Failed to remove ${staffName} start BTB: ${e instanceof Error ? e.message : "Unknown"}`;
          errors.push(errMsg);
          console.error(`[Webhook] Error: ${errMsg}`);
        }
      }

      if (analysis.endBlockShouldRemove && analysis.endBlock) {
        try {
          await deleteTimeblock(analysis.endBlock.id);
          deletedBlocks.push(
            `${staffName} end BTB (${analysis.endGapMinutes}min gap, ${analysis.utilizationPercent}% util)`
          );
          console.log(`[Webhook] Removed: ${staffName} end BTB`);
        } catch (e) {
          const errMsg = `Failed to remove ${staffName} end BTB: ${e instanceof Error ? e.message : "Unknown"}`;
          errors.push(errMsg);
          console.error(`[Webhook] Error: ${errMsg}`);
        }
      }

      // AUTO-ADD: Only on cancellations - Tiered BTB based on gap size
      // 120+ min gap → 60 min BTB
      // 90-119 min gap → 30 min BTB
      if (isCancellation) {
        const startGap = analysis.minutesToFirstAppointment;
        const endGap = analysis.minutesAfterLastAppointment;

        // Check start of shift
        if (!analysis.startBlock && startGap !== undefined && startGap >= 90) {
          const btbDuration = startGap >= 120 ? 60 : 30;
          try {
            const shiftStart = new Date(shift.startAt);
            await createTimeblock({
              locationId,
              staffId: shift.staffMember.id,
              startTime: shiftStart.toISOString(),
              duration: btbDuration,
              title: "BTB",
            });
            addedBlocks.push(
              `${staffName} start BTB ${btbDuration}min (${startGap}min space)`
            );
            console.log(`[Webhook] Added: ${staffName} start BTB (${btbDuration}min for ${startGap}min gap)`);
          } catch (e) {
            const errMsg = `Failed to add ${staffName} start BTB: ${e instanceof Error ? e.message : "Unknown"}`;
            errors.push(errMsg);
            console.error(`[Webhook] Error: ${errMsg}`);
          }
        }

        // Check end of shift
        if (!analysis.endBlock && endGap !== undefined && endGap >= 90) {
          const btbDuration = endGap >= 120 ? 60 : 30;
          try {
            const shiftEnd = new Date(shift.endAt);
            const btbStart = new Date(shiftEnd.getTime() - btbDuration * 60 * 1000);
            await createTimeblock({
              locationId,
              staffId: shift.staffMember.id,
              startTime: btbStart.toISOString(),
              duration: btbDuration,
              title: "BTB",
            });
            addedBlocks.push(
              `${staffName} end BTB ${btbDuration}min (${endGap}min space)`
            );
            console.log(`[Webhook] Added: ${staffName} end BTB (${btbDuration}min for ${endGap}min gap)`);
          } catch (e) {
            const errMsg = `Failed to add ${staffName} end BTB: ${e instanceof Error ? e.message : "Unknown"}`;
            errors.push(errMsg);
            console.error(`[Webhook] Error: ${errMsg}`);
          }
        }
      }
    }

    // Log to changelog
    if (deletedBlocks.length > 0 || addedBlocks.length > 0 || errors.length > 0) {
      logChange({
        action: "webhook",
        mode: "execute",
        location: locationId,
        details: [...deletedBlocks, ...addedBlocks, ...errors],
        added: addedBlocks.length,
        skipped: 0,
        errors: errors.length,
        removed: deletedBlocks.length,
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[Webhook] Completed in ${duration}ms: ${deletedBlocks.length} removed, ${addedBlocks.length} added, ${errors.length} errors`);

    return c.json({
      status: "processed",
      locationId,
      date: startDate,
      staffId: staffId || "all",
      shiftsChecked: shifts.length,
      blocksRemoved: deletedBlocks.length,
      blocksAdded: addedBlocks.length,
      removed: deletedBlocks,
      added: addedBlocks,
      errors: errors.length > 0 ? errors : undefined,
      durationMs: duration,
    });
  } catch (e) {
    console.error("[Webhook] Error:", e);
    return c.json(
      { status: "error", message: e instanceof Error ? e.message : "Unknown error" },
      500
    );
  }
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "btb-admin-server",
    timestamp: new Date().toISOString(),
  });
});

const PORT = parseInt(process.env.PORT || "3001", 10);
console.log(`[STARTUP] Starting BTB Admin Server...`);
console.log(`[STARTUP] NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`[STARTUP] PORT: ${PORT}`);
console.log(`[STARTUP] __dirname: ${__dirname}`);
console.log(`[STARTUP] ENROLLMENT_FILE: ${ENROLLMENT_FILE}`);
console.log(`BTB Admin Server running at http://localhost:${PORT}/btb-admin`);
console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/boulevard`);

try {
  serve({
    fetch: app.fetch,
    port: PORT,
    hostname: "0.0.0.0",
  });
  console.log(`[STARTUP] Server started successfully on port ${PORT}`);
} catch (e) {
  console.error(`[STARTUP] Failed to start server:`, e);
  process.exit(1);
}

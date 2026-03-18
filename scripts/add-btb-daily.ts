/**
 * Daily BTB Addition Script
 *
 * Usage:
 *   npx tsx scripts/add-btb-daily.ts --bootstrap    # First run: all 14 days (enrolled only)
 *   npx tsx scripts/add-btb-daily.ts                # Daily run: only day 14 (enrolled only)
 *   npx tsx scripts/add-btb-daily.ts --dry-run      # Preview without making changes
 *   npx tsx scripts/add-btb-daily.ts --location "sugar house"  # Single location (override enrollment)
 *   npx tsx scripts/add-btb-daily.ts --all          # Process ALL locations (ignore enrollment)
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getLocations,
  getShifts,
  getAppointments,
  getTimeblocks,
  analyzeBTBBlocks,
  executeBTBActions,
  DEFAULT_BTB_CONFIG,
  type BTBCleanupConfig,
  type Timeblock,
} from "../lib/boulevard.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Get enrolled locations
function getEnrolledLocations(): string[] {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const enrollmentFile = join(__dirname, "..", "enrolled-locations.json");
  try {
    if (existsSync(enrollmentFile)) {
      const data = JSON.parse(readFileSync(enrollmentFile, "utf-8"));
      return data.locations || [];
    }
  } catch (e) {
    console.error("Error reading enrollment file:", e);
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const bootstrap = args.includes("--bootstrap");
  const dryRun = args.includes("--dry-run");
  const locationArg = args.find((_, i, arr) => arr[i - 1] === "--location");

  const config: BTBCleanupConfig = {
    ...DEFAULT_BTB_CONFIG,
    utilizationThreshold: Number(process.env.BTB_UTILIZATION_THRESHOLD) || 50,
    minGapMinutes: Number(process.env.BTB_MIN_GAP_MINUTES) || 60,
    emptyWindowMinutes: Number(process.env.BTB_EMPTY_WINDOW_MINUTES) || 120,
    btbDurationMinutes: Number(process.env.BTB_DURATION_MINUTES) || 60,
    lookAheadDays: 14,
  };

  // Determine which days to process
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let datesToProcess: string[];
  if (bootstrap) {
    // Bootstrap: all 14 days
    datesToProcess = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      datesToProcess.push(d.toISOString().split("T")[0]);
    }
    console.log(`BOOTSTRAP MODE: Processing all 14 days (${datesToProcess[0]} to ${datesToProcess[13]})\n`);
  } else {
    // Daily: only day 14
    const day14 = new Date(today);
    day14.setDate(day14.getDate() + 13); // 0-indexed, so +13 = day 14
    datesToProcess = [day14.toISOString().split("T")[0]];
    console.log(`DAILY MODE: Processing day 14 only (${datesToProcess[0]})\n`);
  }

  if (dryRun) {
    console.log("DRY RUN - no changes will be made\n");
  }

  // Get locations
  const allLocations = await getLocations();
  const processAll = args.includes("--all");
  let locations = allLocations;

  if (locationArg) {
    // Specific location override
    locations = allLocations.filter(l =>
      l.name.toLowerCase().includes(locationArg.toLowerCase())
    );
    if (locations.length === 0) {
      console.log(`No locations found matching: ${locationArg}`);
      return;
    }
    console.log(`Location override: ${locations.map(l => l.name).join(", ")}\n`);
  } else if (!processAll) {
    // Use enrolled locations only
    const enrolledIds = getEnrolledLocations();
    if (enrolledIds.length === 0) {
      console.log("No locations enrolled. Use --all to process all locations, or enroll locations via the admin UI.");
      return;
    }
    locations = allLocations.filter(l => enrolledIds.includes(l.id));
    console.log(`Processing ${locations.length} enrolled locations...\n`);
  } else {
    console.log(`Processing ALL ${locations.length} locations...\n`);
  }

  let totalAdded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const location of locations) {
    await sleep(1000); // Rate limiting between locations

    let locationAdded = 0;
    const locationResults: string[] = [];

    // Fetch all timeblocks once for this location (for overlap detection)
    let allTimeblocks: Timeblock[];
    try {
      allTimeblocks = await getTimeblocks(location.id);
      await sleep(1500); // Wait after expensive query
    } catch (e: any) {
      if (e.message?.includes("API limit")) {
        console.log(`${location.name}: Rate limited, skipping...`);
        await sleep(3000);
        continue;
      }
      throw e;
    }

    for (const date of datesToProcess) {
      await sleep(500); // Rate limiting between days

      let shifts, appointments;
      try {
        shifts = await getShifts(location.id, date, date);
        await sleep(200);
        appointments = await getAppointments(location.id, date, date);
      } catch (e: any) {
        if (e.message?.includes("API limit")) {
          console.log(`${location.name} ${date}: Rate limited, skipping...`);
          await sleep(2000);
          continue;
        }
        throw e;
      }

      if (shifts.length === 0) continue;

      // Filter timeblocks to this date for analysis
      const dateTimeblocks = allTimeblocks.filter(tb => tb.startAt.includes(date));

      for (const shift of shifts) {
        const analysis = analyzeBTBBlocks(shift, appointments, dateTimeblocks, config);

        // Only process additions (removals are handled by webhook on new bookings)
        if (!analysis.startBlockShouldAdd && !analysis.endBlockShouldAdd) continue;

        if (dryRun) {
          // Even in dry run, check for overlaps to give accurate count
          const staffName = shift.staffMember.displayName || shift.staffMember.name;
          const staffId = shift.staffMember.id.replace("urn:blvd:Staff:", "");

          const wouldOverlap = (proposedStart: Date, durationMin: number): boolean => {
            const proposedEnd = proposedStart.getTime() + durationMin * 60 * 1000;
            return allTimeblocks.some(tb => {
              const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
              if (tbStaffId !== staffId) return false;
              const tbStart = new Date(tb.startAt).getTime();
              const tbEnd = new Date(tb.endAt).getTime();
              return proposedStart.getTime() < tbEnd && proposedEnd > tbStart;
            });
          };

          if (analysis.startBlockShouldAdd) {
            const startTime = new Date(shift.startAt);
            if (wouldOverlap(startTime, config.btbDurationMinutes)) {
              totalSkipped++;
            } else {
              locationResults.push(`  ${date} ${staffName}: would add start BTB`);
              locationAdded++;
            }
          }
          if (analysis.endBlockShouldAdd) {
            const shiftEnd = new Date(shift.endAt);
            const startTime = new Date(shiftEnd.getTime() - config.btbDurationMinutes * 60 * 1000);
            if (wouldOverlap(startTime, config.btbDurationMinutes)) {
              totalSkipped++;
            } else {
              locationResults.push(`  ${date} ${staffName}: would add end BTB`);
              locationAdded++;
            }
          }
        } else {
          await sleep(200);
          const result = await executeBTBActions(analysis, config, allTimeblocks);

          for (const added of result.added) {
            locationResults.push(`  ${date}: ${added}`);
            locationAdded++;
          }
          for (const err of result.errors) {
            locationResults.push(`  ${date}: ERROR - ${err}`);
            totalErrors++;
          }

          // Count skipped (overlap prevention)
          const recommended = (analysis.startBlockShouldAdd ? 1 : 0) + (analysis.endBlockShouldAdd ? 1 : 0);
          totalSkipped += recommended - result.added.length;
        }
      }
    }

    if (locationAdded > 0 || locationResults.some(r => r.includes("ERROR"))) {
      console.log(`${location.name}:`);
      locationResults.forEach(r => console.log(r));
      totalAdded += locationAdded;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Locations processed: ${locations.length}`);
  console.log(`Days processed: ${datesToProcess.length}`);
  console.log(`BTB blocks ${dryRun ? "would be " : ""}added: ${totalAdded}`);
  console.log(`Skipped (overlap): ${totalSkipped}`);
  if (totalErrors > 0) {
    console.log(`Errors: ${totalErrors}`);
  }
}

main().catch(console.error);

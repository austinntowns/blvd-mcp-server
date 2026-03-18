import "dotenv/config";
import {
  getLocations,
  getShifts,
  getAppointments,
  getTimeblocksInRange,
  analyzeBTBBlocks,
  deleteTimeblock,
  type BTBCleanupConfig,
} from "../lib/boulevard.js";

async function main() {
  const args = process.argv.slice(2);
  const locationSearch = args[0] || "sugar house";
  const targetDate = args[1] || "2026-03-23";
  const dryRun = args[2] === "--dry-run";

  console.log(`\n${dryRun ? "DRY RUN - " : ""}Cleaning up BTB blocks`);
  console.log(`Location: ${locationSearch}`);
  console.log(`Date: ${targetDate}\n`);

  const locations = await getLocations();
  const location = locations.find((l) =>
    l.name.toLowerCase().includes(locationSearch.toLowerCase())
  );

  if (!location) {
    console.log("Location not found");
    return;
  }

  console.log(`Found: ${location.name}\n`);

  const config: BTBCleanupConfig = {
    utilizationThreshold: 50,
    minGapMinutes: 60,
    lookAheadDays: 14,
  };

  // Get data
  const [shifts, appointments, timeblocks] = await Promise.all([
    getShifts(location.id, targetDate, targetDate),
    getAppointments(location.id, targetDate, targetDate),
    getTimeblocksInRange(location.id, targetDate, targetDate),
  ]);

  console.log(`Found ${shifts.length} shifts, ${appointments.length} appointments, ${timeblocks.length} timeblocks\n`);

  let deleted = 0;

  for (const shift of shifts) {
    const analysis = analyzeBTBBlocks(shift, appointments, timeblocks, config);
    const staffName = shift.staffMember.displayName || shift.staffMember.name;

    if (analysis.startBlockShouldRemove && analysis.startBlock) {
      console.log(`${dryRun ? "[DRY RUN] Would delete" : "Deleting"} START block for ${staffName}`);
      console.log(`  Block ID: ${analysis.startBlock.id}`);
      console.log(`  Time: ${analysis.startBlock.startAt} - ${analysis.startBlock.endAt}`);
      console.log(`  Reason: ${analysis.utilizationPercent}% util, ${analysis.startGapMinutes}min gap`);

      if (!dryRun) {
        try {
          await deleteTimeblock(analysis.startBlock.id);
          console.log(`  ✓ Deleted\n`);
          deleted++;
        } catch (e) {
          console.log(`  ✗ Error: ${e instanceof Error ? e.message : "Unknown"}\n`);
        }
      } else {
        console.log();
      }
    }

    if (analysis.endBlockShouldRemove && analysis.endBlock) {
      console.log(`${dryRun ? "[DRY RUN] Would delete" : "Deleting"} END block for ${staffName}`);
      console.log(`  Block ID: ${analysis.endBlock.id}`);
      console.log(`  Time: ${analysis.endBlock.startAt} - ${analysis.endBlock.endAt}`);
      console.log(`  Reason: ${analysis.utilizationPercent}% util, ${analysis.endGapMinutes}min gap`);

      if (!dryRun) {
        try {
          await deleteTimeblock(analysis.endBlock.id);
          console.log(`  ✓ Deleted\n`);
          deleted++;
        } catch (e) {
          console.log(`  ✗ Error: ${e instanceof Error ? e.message : "Unknown"}\n`);
        }
      } else {
        console.log();
      }
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`${dryRun ? "Would delete" : "Deleted"} ${deleted} blocks`);
}

main().catch(console.error);

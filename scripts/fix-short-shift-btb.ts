/**
 * Fix BTB blocks on short shifts (under 4 hours)
 *
 * Usage:
 *   npx tsx scripts/fix-short-shift-btb.ts --dry-run
 *   npx tsx scripts/fix-short-shift-btb.ts --execute
 */

import "dotenv/config";
import {
  getLocations,
  getShifts,
  getTimeblocks,
  deleteTimeblock,
  type Timeblock,
} from "../lib/boulevard.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MIN_SHIFT_HOURS = 4;

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const dryRun = !execute;

  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}\n`);

  // Get Sugar House and West Valley locations
  const allLocations = await getLocations();
  const locations = allLocations.filter(l =>
    l.name.toLowerCase().includes("sugar house") ||
    l.name.toLowerCase().includes("west valley")
  );

  console.log(`Checking ${locations.length} locations: ${locations.map(l => l.name).join(", ")}\n`);

  const toDelete: { timeblock: Timeblock; location: string; reason: string }[] = [];

  for (const location of locations) {
    console.log(`\n=== ${location.name} ===`);
    await sleep(500);

    // Get all timeblocks
    let timeblocks: Timeblock[];
    try {
      timeblocks = await getTimeblocks(location.id);
    } catch (e: any) {
      console.log(`  Error fetching timeblocks: ${e.message}`);
      continue;
    }

    // Filter to Auto - BTB blocks only
    const autoBtbBlocks = timeblocks.filter(tb =>
      tb.title?.toLowerCase().includes("auto - btb") ||
      tb.title?.toLowerCase().includes("auto-btb")
    );

    if (autoBtbBlocks.length === 0) {
      console.log("  No Auto-BTB blocks found");
      continue;
    }

    console.log(`  Found ${autoBtbBlocks.length} Auto-BTB blocks`);

    // Get unique dates from the blocks
    const dates = [...new Set(autoBtbBlocks.map(tb => tb.startAt.split("T")[0]))];

    for (const date of dates) {
      await sleep(300);

      // Get shifts for this date
      let shifts;
      try {
        shifts = await getShifts(location.id, date, date);
      } catch (e: any) {
        console.log(`  Error fetching shifts for ${date}: ${e.message}`);
        continue;
      }

      // Check each Auto-BTB block on this date
      const dateBlocks = autoBtbBlocks.filter(tb => tb.startAt.includes(date));

      for (const block of dateBlocks) {
        const blockStaffId = block.staff?.id?.replace("urn:blvd:Staff:", "") || "";

        // Find the shift this block belongs to
        const shift = shifts.find(s => {
          const shiftStaffId = s.staffMember.id.replace("urn:blvd:Staff:", "");
          return shiftStaffId === blockStaffId;
        });

        if (!shift) {
          console.log(`  ${date}: Block for unknown staff - ${block.title}`);
          continue;
        }

        // Calculate shift duration
        const shiftStart = new Date(shift.startAt);
        const shiftEnd = new Date(shift.endAt);
        const shiftDurationHours = (shiftEnd.getTime() - shiftStart.getTime()) / (1000 * 60 * 60);

        const staffName = shift.staffMember.displayName || shift.staffMember.name;

        if (shiftDurationHours < MIN_SHIFT_HOURS) {
          console.log(`  ${date} ${staffName}: ${shiftDurationHours.toFixed(1)}h shift - SHOULD DELETE`);
          toDelete.push({
            timeblock: block,
            location: location.name,
            reason: `${shiftDurationHours.toFixed(1)}h shift (< ${MIN_SHIFT_HOURS}h minimum)`
          });
        } else {
          console.log(`  ${date} ${staffName}: ${shiftDurationHours.toFixed(1)}h shift - OK`);
        }
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Blocks to delete: ${toDelete.length}`);

  if (toDelete.length === 0) {
    console.log("No blocks need to be removed.");
    return;
  }

  console.log("\nBlocks to remove:");
  for (const item of toDelete) {
    console.log(`  - ${item.location}: ${item.timeblock.startAt.split("T")[0]} - ${item.reason}`);
  }

  if (execute) {
    console.log("\nDeleting blocks...");
    let deleted = 0;
    let errors = 0;

    for (const item of toDelete) {
      await sleep(500);
      try {
        await deleteTimeblock(item.timeblock.id);
        console.log(`  ✓ Deleted: ${item.timeblock.startAt}`);
        deleted++;
      } catch (e: any) {
        console.log(`  ✗ Error: ${e.message}`);
        errors++;
      }
    }

    console.log(`\nDeleted: ${deleted}, Errors: ${errors}`);
  } else {
    console.log("\nDry run complete. Use --execute to delete these blocks.");
  }
}

main().catch(console.error);

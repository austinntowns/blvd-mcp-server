import "dotenv/config";
import {
  getLocations,
  getShifts,
  getAppointments,
  getTimeblocksInRange,
  analyzeBTBBlocks,
  DEFAULT_BTB_CONFIG,
  type BTBCleanupConfig,
} from "../lib/boulevard.js";

async function main() {
  const args = process.argv.slice(2);
  const locationSearch = args[0] || "sugarhouse";
  const targetDate = args[1] || "2026-03-23";

  console.log(`\nSearching for location: ${locationSearch}`);

  const locations = await getLocations();
  const matchedLocations = locations.filter((l) =>
    l.name.toLowerCase().includes(locationSearch.toLowerCase())
  );

  if (matchedLocations.length === 0) {
    console.log("No locations found matching:", locationSearch);
    console.log("\nAvailable locations:");
    locations.forEach((l) => console.log(`  - ${l.name} (${l.id})`));
    return;
  }

  const location = matchedLocations[0];
  console.log(`Found: ${location.name} (${location.id})\n`);

  const config: BTBCleanupConfig = {
    ...DEFAULT_BTB_CONFIG,
    utilizationThreshold: 50,
    minGapMinutes: 60,
    emptyWindowMinutes: 120,
    btbDurationMinutes: 60,
  };

  console.log(`Analyzing date: ${targetDate}`);
  console.log(`Config:`);
  console.log(`  - Remove BTB: utilization >= ${config.utilizationThreshold}% AND gap < ${config.minGapMinutes}min`);
  console.log(`  - Add BTB: utilization < ${config.utilizationThreshold}% AND no appointments in first/last ${config.emptyWindowMinutes}min`);
  console.log(`  - BTB duration: ${config.btbDurationMinutes}min\n`);

  // Get shifts, appointments, and timeblocks for this date
  const [shifts, appointments, timeblocks] = await Promise.all([
    getShifts(location.id, targetDate, targetDate),
    getAppointments(location.id, targetDate, targetDate),
    getTimeblocksInRange(location.id, targetDate, targetDate),
  ]);

  console.log(`Found ${shifts.length} shifts, ${appointments.length} appointments, ${timeblocks.length} timeblocks\n`);

  // Show all timeblocks
  if (timeblocks.length > 0) {
    console.log("=== TIMEBLOCKS ===");
    for (const tb of timeblocks) {
      const start = new Date(tb.startAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const end = new Date(tb.endAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const isBTB = tb.title?.toLowerCase().includes("btb") ? "✓ BTB" : "";
      console.log(`  ${tb.staff?.name || "Unknown"}: ${start}-${end} "${tb.title || "(no title)"}" ${isBTB}`);
    }
    console.log();
  }

  // Analyze each shift
  console.log("=== SHIFT ANALYSIS ===");
  const analyses = shifts.map((s) => analyzeBTBBlocks(s, appointments, timeblocks, config));

  for (const analysis of analyses) {
    const staffName = analysis.shift.staffMember.displayName || analysis.shift.staffMember.name;
    const shiftStart = new Date(analysis.shift.startAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const shiftEnd = new Date(analysis.shift.endAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const hasAction = analysis.startBlockShouldRemove || analysis.endBlockShouldRemove ||
                      analysis.startBlockShouldAdd || analysis.endBlockShouldAdd;

    console.log(`\n${staffName} (${shiftStart} - ${shiftEnd})`);
    console.log(`  Utilization: ${analysis.utilizationPercent}%`);

    if (analysis.minutesToFirstAppointment !== undefined) {
      console.log(`  First appt: ${analysis.minutesToFirstAppointment}min into shift`);
    } else {
      console.log(`  First appt: none`);
    }
    if (analysis.minutesAfterLastAppointment !== undefined) {
      console.log(`  Last appt ends: ${analysis.minutesAfterLastAppointment}min before shift end`);
    }

    // Start block status
    if (analysis.startBlock) {
      if (analysis.startBlockShouldRemove) {
        console.log(`  Start BTB: ⚠️  REMOVE (gap: ${analysis.startGapMinutes}min)`);
      } else {
        console.log(`  Start BTB: ✓ exists`);
      }
    } else if (analysis.startBlockShouldAdd) {
      console.log(`  Start BTB: ➕ ADD (no appts in first ${config.emptyWindowMinutes}min)`);
    } else {
      console.log(`  Start BTB: - none needed`);
    }

    // End block status
    if (analysis.endBlock) {
      if (analysis.endBlockShouldRemove) {
        console.log(`  End BTB: ⚠️  REMOVE (gap: ${analysis.endGapMinutes}min)`);
      } else {
        console.log(`  End BTB: ✓ exists`);
      }
    } else if (analysis.endBlockShouldAdd) {
      console.log(`  End BTB: ➕ ADD (no appts in last ${config.emptyWindowMinutes}min)`);
    } else {
      console.log(`  End BTB: - none needed`);
    }
  }

  console.log("\n=== SUMMARY ===");
  const toRemove = analyses.filter((a) => a.startBlockShouldRemove || a.endBlockShouldRemove);
  const toAdd = analyses.filter((a) => a.startBlockShouldAdd || a.endBlockShouldAdd);

  const startRemove = analyses.filter((a) => a.startBlockShouldRemove).length;
  const endRemove = analyses.filter((a) => a.endBlockShouldRemove).length;
  const startAdd = analyses.filter((a) => a.startBlockShouldAdd).length;
  const endAdd = analyses.filter((a) => a.endBlockShouldAdd).length;

  if (toRemove.length === 0 && toAdd.length === 0) {
    console.log("No BTB changes needed.");
  } else {
    if (toRemove.length > 0) {
      console.log(`Remove: ${startRemove + endRemove} blocks (${startRemove} start, ${endRemove} end)`);
    }
    if (toAdd.length > 0) {
      console.log(`Add: ${startAdd + endAdd} blocks (${startAdd} start, ${endAdd} end)`);
    }
  }
}

main().catch(console.error);

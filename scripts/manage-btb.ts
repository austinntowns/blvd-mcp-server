import "dotenv/config";
import {
  getLocations,
  getShifts,
  getAppointments,
  getTimeblocksInRange,
  analyzeBTBBlocks,
  executeBTBActions,
  DEFAULT_BTB_CONFIG,
  type BTBCleanupConfig,
} from "../lib/boulevard.js";

async function main() {
  const args = process.argv.slice(2);
  const locationSearch = args[0];
  const targetDate = args[1];
  const dryRun = args.includes("--dry-run");
  const execute = args.includes("--execute");

  if (!locationSearch || !targetDate) {
    console.log("Usage: npx tsx scripts/manage-btb.ts <location> <date> [--dry-run | --execute]");
    console.log("  --dry-run   Show what would be done (default)");
    console.log("  --execute   Actually make changes");
    console.log("\nExamples:");
    console.log("  npx tsx scripts/manage-btb.ts 'sugar house' 2026-03-23 --dry-run");
    console.log("  npx tsx scripts/manage-btb.ts 'sugar house' 2026-03-23 --execute");
    return;
  }

  console.log(`\nSearching for location: ${locationSearch}`);

  const locations = await getLocations();
  const matchedLocations = locations.filter((l) =>
    l.name.toLowerCase().includes(locationSearch.toLowerCase())
  );

  if (matchedLocations.length === 0) {
    console.log("No locations found matching:", locationSearch);
    return;
  }

  const location = matchedLocations[0];
  console.log(`Found: ${location.name}\n`);

  const config: BTBCleanupConfig = {
    ...DEFAULT_BTB_CONFIG,
    utilizationThreshold: Number(process.env.BTB_UTILIZATION_THRESHOLD) || 50,
    minGapMinutes: Number(process.env.BTB_MIN_GAP_MINUTES) || 60,
    emptyWindowMinutes: Number(process.env.BTB_EMPTY_WINDOW_MINUTES) || 120,
    btbDurationMinutes: Number(process.env.BTB_DURATION_MINUTES) || 60,
  };

  console.log(`Date: ${targetDate}`);
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}\n`);

  // Get shifts, appointments, and timeblocks for this date
  const [shifts, appointments, timeblocks] = await Promise.all([
    getShifts(location.id, targetDate, targetDate),
    getAppointments(location.id, targetDate, targetDate),
    getTimeblocksInRange(location.id, targetDate, targetDate),
  ]);

  console.log(`Found ${shifts.length} shifts\n`);

  // Analyze and execute for each shift
  const allRemoved: string[] = [];
  const allAdded: string[] = [];
  const allErrors: string[] = [];

  for (const shift of shifts) {
    const analysis = analyzeBTBBlocks(shift, appointments, timeblocks, config);
    const staffName = shift.staffMember.displayName || shift.staffMember.name;
    const hasActions = analysis.startBlockShouldRemove || analysis.endBlockShouldRemove ||
                       analysis.startBlockShouldAdd || analysis.endBlockShouldAdd;

    if (!hasActions) continue;

    console.log(`${staffName} (${analysis.utilizationPercent}% utilization):`);

    if (analysis.startBlockShouldRemove) {
      console.log(`  - Would remove start BTB (gap: ${analysis.startGapMinutes}min)`);
    }
    if (analysis.endBlockShouldRemove) {
      console.log(`  - Would remove end BTB (gap: ${analysis.endGapMinutes}min)`);
    }
    if (analysis.startBlockShouldAdd) {
      console.log(`  - Would add start BTB (${config.btbDurationMinutes}min)`);
    }
    if (analysis.endBlockShouldAdd) {
      console.log(`  - Would add end BTB (${config.btbDurationMinutes}min)`);
    }

    if (execute) {
      const result = await executeBTBActions(analysis, config, timeblocks);
      allRemoved.push(...result.removed);
      allAdded.push(...result.added);
      allErrors.push(...result.errors);
    }
  }

  console.log("\n=== SUMMARY ===");
  if (execute) {
    if (allRemoved.length > 0) {
      console.log("Removed:");
      allRemoved.forEach((r) => console.log(`  ✓ ${r}`));
    }
    if (allAdded.length > 0) {
      console.log("Added:");
      allAdded.forEach((a) => console.log(`  ✓ ${a}`));
    }
    if (allErrors.length > 0) {
      console.log("Errors:");
      allErrors.forEach((e) => console.log(`  ✗ ${e}`));
    }
    if (allRemoved.length === 0 && allAdded.length === 0 && allErrors.length === 0) {
      console.log("No changes needed.");
    }
  } else {
    console.log("Dry run complete. Use --execute to apply changes.");
  }
}

main().catch(console.error);

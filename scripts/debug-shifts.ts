import "dotenv/config";
import {
  getLocations,
  getShifts,
  getStaff,
  getTimeblocks,
} from "../lib/boulevard.js";

async function main() {
  const locations = await getLocations();
  const sugarhouse = locations.find((l) => l.name.toLowerCase().includes("sugar house"));

  if (!sugarhouse) {
    console.log("Location not found");
    return;
  }

  console.log("Location:", sugarhouse.name);
  console.log("Location ID:", sugarhouse.id);

  const targetDate = "2026-03-23";

  // Get shifts
  const shifts = await getShifts(sugarhouse.id, targetDate, targetDate);
  console.log("\n=== SHIFTS ===");
  for (const shift of shifts) {
    console.log(`Staff: ${shift.staffMember.name} (${shift.staffId})`);
    console.log(`  Time: ${shift.startAt} - ${shift.endAt}`);
  }

  // Get staff for this location
  const staff = await getStaff(sugarhouse.id);
  console.log("\n=== STAFF AT LOCATION ===");
  for (const s of staff) {
    console.log(`${s.name} (${s.id})`);
  }

  // Get timeblocks
  const timeblocks = await getTimeblocks(sugarhouse.id);
  console.log("\n=== TIMEBLOCKS ===");
  for (const tb of timeblocks) {
    if (tb.startAt.includes(targetDate)) {
      console.log(`Staff: ${tb.staff?.name} (${tb.staff?.id})`);
      console.log(`  Time: ${tb.startAt} - ${tb.endAt}`);
      console.log(`  Title: ${tb.title}`);
    }
  }
}

main().catch(console.error);

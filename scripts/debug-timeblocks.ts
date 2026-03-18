import "dotenv/config";
import { getTimeblocksInRange } from "../lib/boulevard.js";

async function main() {
  const locationId = "urn:blvd:Location:1d546022-4d3d-4f0f-9414-321e6251b595";
  const targetDate = "2026-03-23";

  const timeblocks = await getTimeblocksInRange(locationId, targetDate, targetDate);

  console.log(`Found ${timeblocks.length} timeblocks on ${targetDate}:\n`);

  for (const tb of timeblocks) {
    const isBTB = tb.title?.toLowerCase().includes("btb") ? "✓ BTB" : "";
    console.log(`${tb.staff?.name}: "${tb.title}" ${isBTB}`);
    console.log(`  ID: ${tb.id}`);
    console.log(`  Time: ${tb.startAt} - ${tb.endAt}`);
    console.log();
  }

  // Check for the deleted IDs
  const deletedIds = [
    "urn:blvd:Timeblock:501ac1e9-8035-46cd-af78-5872b743ada0",
    "urn:blvd:Timeblock:2a736608-494f-4cfa-990e-523882cc3a3b"
  ];

  console.log("Deleted block status:");
  for (const id of deletedIds) {
    const found = timeblocks.find((tb) => tb.id === id);
    console.log(`  ${id.split(":").pop()}: ${found ? "STILL EXISTS" : "DELETED"}`);
  }
}

main().catch(console.error);

/**
 * Remove duplicate BTB blocks (keep one per staff/time, delete the rest).
 * Usage:
 *   npx tsx scripts/dedup-btb.ts --dry-run   # preview
 *   npx tsx scripts/dedup-btb.ts              # delete duplicates
 */
import "dotenv/config";
import { getLocations, getTimeblocks, deleteTimeblock, type Timeblock } from "../lib/boulevard.js";

const enrolled = [
  "urn:blvd:Location:e85763a3-1f61-43e4-929e-fd89f8a368ed",
  "urn:blvd:Location:9a773de9-5af5-4919-a969-1071158cfd57",
  "urn:blvd:Location:d1a666f5-a1c3-4aa7-a947-7ef73324ff7d",
  "urn:blvd:Location:1d546022-4d3d-4f0f-9414-321e6251b595",
  "urn:blvd:Location:380d3d5a-2b83-4616-80c0-2384b79470f7",
  "urn:blvd:Location:0deaa531-9fc0-4ccc-98d8-66f9b988c66c",
  "urn:blvd:Location:61921eab-3a5a-4858-a969-1b85af789076",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const locs = await getLocations();
  let totalDeleted = 0;

  for (const loc of locs.filter((l) => enrolled.includes(l.id))) {
    await sleep(1500);
    const tbs = await getTimeblocks(loc.id);
    const btbs = tbs.filter(
      (tb: Timeblock) => tb.title?.toLowerCase().includes("btb")
    );

    // Group by staff + exact start time
    const groups = new Map<string, Timeblock[]>();
    for (const tb of btbs) {
      const staff = tb.staff?.id || "unknown";
      const key = `${staff}|${tb.startAt}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(tb);
    }

    let locDeleted = 0;
    for (const [, blocks] of groups) {
      if (blocks.length <= 1) continue;

      // Keep the first, delete the rest
      const toDelete = blocks.slice(1);
      for (const tb of toDelete) {
        const staffName = tb.staff?.name || "unknown";
        const date = tb.startAt.split("T")[0];
        if (dryRun) {
          console.log(`[DRY] ${loc.name} | ${staffName} | ${date} ${tb.startAt} | would delete ${tb.id}`);
        } else {
          try {
            await deleteTimeblock(tb.id);
            console.log(`✓ ${loc.name} | ${staffName} | ${date} | deleted ${tb.id}`);
            await sleep(500);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`✗ ${loc.name} | ${tb.id} | ${msg}`);
          }
        }
        locDeleted++;
      }
    }

    if (locDeleted > 0) {
      totalDeleted += locDeleted;
    } else {
      console.log(`${loc.name}: no duplicates`);
    }
  }

  console.log(`\n=== ${dryRun ? "Would delete" : "Deleted"}: ${totalDeleted} duplicate BTBs ===`);
}

main().catch(console.error);

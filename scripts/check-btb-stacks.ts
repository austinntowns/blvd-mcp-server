import "dotenv/config";
import { getLocations, getTimeblocks, type Timeblock } from "../lib/boulevard.js";

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

async function main() {
  const locs = await getLocations();
  let totalStacks = 0;

  for (const loc of locs.filter((l) => enrolled.includes(l.id))) {
    await sleep(1500);
    const tbs = await getTimeblocks(loc.id);
    const btbs = tbs.filter(
      (tb: Timeblock) => tb.title?.toLowerCase().includes("btb") && !(tb as Record<string, unknown>).cancelled
    );

    // Group by staff + date
    const groups = new Map<string, Timeblock[]>();
    for (const tb of btbs) {
      const date = tb.startAt.split("T")[0];
      const staff = tb.staff?.name || "unknown";
      const key = `${staff}|${date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(tb);
    }

    // Find stacks (>2 BTBs for same staff/date)
    let hasStacks = false;
    for (const [key, blocks] of groups) {
      if (blocks.length > 2) {
        if (!hasStacks) {
          console.log(`\n${loc.name}:`);
          hasStacks = true;
        }
        const [staff, date] = key.split("|");
        console.log(`  ⚠️ ${staff} on ${date}: ${blocks.length} BTBs`);
        for (const b of blocks.sort((a, b) => a.startAt.localeCompare(b.startAt))) {
          console.log(`    ${b.startAt} → ${b.endAt} "${b.title}" (${b.id})`);
        }
        totalStacks += blocks.length - 2; // excess beyond the expected 2
      }
    }
    if (!hasStacks) console.log(`${loc.name}: ✅ no stacks`);
  }

  console.log(`\n=== ${totalStacks} excess BTB blocks found ===`);
}

main().catch(console.error);

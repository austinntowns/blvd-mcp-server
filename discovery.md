# Boulevard Operations MCP Server - Discovery

## BTB Auto-Cleanup Requirements (2026-03-17)

**Q: What are BTB blocks?**
A: Buffer blocks placed at the first and last hour of every shift to encourage bookings in the middle of shifts, avoiding edge bookings.

**Q: How are BTB blocks identified?**
A: Title includes "BTB" or "btb" (case-insensitive)

**Q: What triggers cleanup?**
A: Should recalculate every time there's a new booking on that shift. Use webhook from Boulevard.

**Q: What are the removal criteria?**
A: Two conditions must be met:
1. Shift utilization >= 50% (configurable)
2. Gap between the block and the nearest appointment < 60 minutes (configurable)

**Q: Which block gets removed (start or end)?**
A: Each block is evaluated independently:
- START block: check gap between block end → first appointment start
- END block: check gap between last appointment end → block start
- Either can be removed if their specific gap is < threshold

**Q: Time window for analysis?**
A: Next 14 days (configurable via BTB_LOOK_AHEAD_DAYS)

---

## User Requirements

**Q: What is the purpose of this server?**
A: Internal ops tool (not client-facing) for Hello Sugar management

**Q: What are the key features needed?**
A:
1. Monitor a group of locations
2. Identify shifts with >60% utilization over last 4 weeks
3. Add/move blocks on staff calendars
4. Surface insights from Boulevard data

**Q: How should utilization insights be surfaced?**
A: Proactively - the `get-busy-shifts` tool analyzes patterns and flags shifts needing more capacity

**Q: Where should the server live long-term?**
A: TBD - Options discussed:
- `~/Dev/blvd-mcp-server/` for personal use
- Manufact Cloud for always-on (recommended for proactive features)
- Self-hosted VPS for full control

## API Findings

**Boulevard API Access:**
- Admin API requires Enterprise tier
- Authentication: Basic auth with API key
- Business ID passed via header

**Available Operations:**
- `shifts` query: Get staff schedules by location + date range
- `appointments` query: Get bookings with filtering
- `createTimeblock` mutation: Block calendar time
- `deleteTimeblock` mutation: Remove blocks
- No `updateTimeblock` found - must delete + recreate to "move" blocks

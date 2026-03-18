# Boulevard Operations MCP Server - Progress

## 2026-03-17 - BTB Management Feature Complete (Session 3)

### Done
- **Fixed BTB deletion** - `deleteTimeblock` mutation marks blocks as `cancelled: true`
  - Added `cancelled` field to TIMEBLOCKS_QUERY
  - Filter out cancelled blocks in `getTimeblocks()`
- **Added BTB creation for low utilization shifts:**
  - New config: `emptyWindowMinutes` (default 120) and `btbDurationMinutes` (default 60)
  - Logic: Add BTB if utilization < 50% AND no appointments in first/last 2 hours
- **Fixed createTimeblock mutation:**
  - Changed `staffMember` to `staff` in response
  - Fixed DateTime format (requires full ISO 8601 with timezone)
  - Fixed ID format (requires full URN: `urn:blvd:Location:uuid`)
- **Created management scripts:**
  - `scripts/test-btb.ts` - analyze BTB status for a location/date
  - `scripts/manage-btb.ts` - execute BTB changes with --dry-run or --execute

### Tested on Sugar House March 23, 2026
- **Lindsey (70.8% utilization):** Both BTB blocks successfully deleted
- **Becca (0% utilization):** Start BTB (8-9 AM) and End BTB (1-2 PM) successfully added

### BTB Logic Summary
```
REMOVE BTB: utilization >= 50% AND gap to first/last appointment < 60 min
ADD BTB: utilization < 50% AND no appointments in first/last 2 hours
```

### Next Steps
- Set up webhook for automatic triggering on new bookings
- Run across all locations for next 14 days
- Deploy to production

---

## 2026-03-17 - BTB Auto-Cleanup Feature (Session 2)

### Done
- Fixed Boulevard API schema mismatches:
  - `shifts` query returns recurring templates with `clockIn`/`clockOut`/`day`, not instances
  - `staff` is a top-level paginated query, not nested in location
  - `timeblocks` use `staff` field not `staffMember`
  - Staff IDs: shifts use UUID only, staff/timeblocks use full URN format
- Updated all queries to use correct fields and pagination
- Added ID normalization for cross-entity matching
- **Tested successfully on Sugar House March 23, 2026:**
  - Found 2 shifts, 8 appointments, 6 timeblocks
  - Correctly identified 2 BTB blocks for removal (Lindsey's start+end blocks)
  - 70.8% utilization with 0min gaps to appointments

---

## 2026-03-17 - BTB Auto-Cleanup Feature (Session 1)

### Done
- Implemented BTB (buffer) block auto-cleanup system:
  - `analyze-btb-blocks` tool - preview which blocks would be removed
  - `cleanup-btb-blocks` tool - execute removal with dry-run option
  - Webhook endpoint `POST /webhook/boulevard` for automatic triggering
  - Health check endpoint `GET /health`
- Core logic in `lib/boulevard.ts`:
  - `isBTBBlock()` - identifies BTB blocks by title
  - `analyzeBTBBlocks()` - evaluates shift for cleanup eligibility
  - `getTimeblocksInRange()` - date-filtered timeblock queries
- Environment config for thresholds (utilization, gap, look-ahead days)

### Notes
- BTB blocks identified by title containing "BTB" or "btb" (case-insensitive)
- Start block = within 15min of shift start, End block = within 15min of shift end
- Removal criteria: utilization >= threshold AND gap < threshold

---

## 2026-03-17 - Initial Setup

### Done
- Scaffolded mcp-use project at `~/Dev/blvd-mcp-server/`
- Installed dependencies (graphql, graphql-request)
- Created Boulevard GraphQL client (`lib/boulevard.ts`)
- Implemented all core tools:
  - Location and staff queries
  - Shift utilization analysis with pattern detection
  - Timeblock CRUD operations
  - Appointments query
- Created `.env` and `.env.example` for credentials

### Next Steps
- User needs to add Boulevard API credentials to `.env`
- Test connection with `list-locations` tool
- Configure specific locations to monitor
- Validate GraphQL queries against live API

### Blockers
- None - awaiting API credentials from user

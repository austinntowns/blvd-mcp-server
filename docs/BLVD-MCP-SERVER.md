# BLVD MCP Server

> AI-powered operations intelligence for Hello Sugar Utah locations using Boulevard's Admin API.

---

## Overview

This MCP server connects to Boulevard's GraphQL Admin API to provide real-time analytics, utilization tracking, and operational intelligence for your 7 Utah salon locations plus 4 acquisition targets.

**Location:** `~/Dev/blvd-mcp-server/`

**Tags:** #hello-sugar #boulevard #mcp #operations #utah

---

## Quick Start

```bash
cd ~/Dev/blvd-mcp-server

# Run daily brief
npx tsx scripts/daily-brief-v2.ts

# Export full data for agent analysis
npx tsx scripts/export-portfolio-data.ts

# Check booking velocity
npx tsx scripts/daily-bookings-report.ts --days 7
```

---

## Your Portfolio

### Owned Locations (7)

| Location | City | ID |
|----------|------|-----|
| Bountiful | Bountiful | `e85763a3-1f61-43e4-929e-fd89f8a368ed` |
| Farmington | Farmington | `61921eab-3a5a-4858-a969-1b85af789076` |
| Heber City | Heber City | `380d3d5a-2b83-4616-80c0-2384b79470f7` |
| Ogden | Riverdale | `d1a666f5-a1c3-4aa7-a947-7ef73324ff7d` |
| Riverton | Riverton | `9a773de9-5af5-4919-a969-1071158cfd57` |
| Sugar House | Salt Lake City | `1d546022-4d3d-4f0f-9414-321e6251b595` |
| West Valley | West Valley City | `0deaa531-9fc0-4ccc-98d8-66f9b988c66c` |

### Acquisition Targets (4)

| Location | City | Timeline |
|----------|------|----------|
| American Fork | American Fork | 2 years |
| Draper | Draper | 2 years |
| Midvale | Midvale | 2 years |
| Spanish Fork | Spanish Fork | 2 years |

**Config file:** `config/utah-locations.json`

---

## Daily Brief Components

The daily brief (`scripts/daily-brief-v2.ts`) provides:

### 1. Booking Velocity
- Yesterday's bookings vs 7-day average
- Per-location trend indicators (🚀 up, ⚠️ flat, 🔴 down)
- New client acquisition count

### 2. Capacity Alerts (≥75% booked)
Shifts that need immediate action:
- Add coverage
- Open waitlist
- Consider demand-based pricing

### 3. Growth Opportunities (≥50% booked)
Shifts becoming constraints on growth:
- Add second aesthetician
- Extend hours
- Cross-train staff

### 4. BTB Management
Back-to-back block recommendations:
- **Remove BTB** when shift is filling up
- **Add BTB** when large gaps exist

### 5. Underutilized Shifts (<20%)
Wasted payroll or marketing opportunity:
- Cut the shift
- Run targeted promos
- Reassign to busier location

### 6. Top Services
Most popular services by location (last 2 weeks)

### 7. Location Leaderboard
All locations ranked by utilization

### 8. AI Recommendations
Actionable insights based on portfolio analysis

---

## Utilization Calculation

```
utilization = booked_minutes / (available_minutes - blocked_minutes)
```

**Excluded from available time:**
- Lunch blocks
- DNB (Do Not Book) blocks

**Included as bookable (NOT excluded):**
- BTB (back-to-back) blocks — these represent unfilled capacity

---

## Scripts Reference

| Script | Purpose | Command |
|--------|---------|---------|
| `daily-brief-v2.ts` | Daily AI operations brief | `npx tsx scripts/daily-brief-v2.ts` |
| `export-portfolio-data.ts` | Full JSON + MD export for agents | `npx tsx scripts/export-portfolio-data.ts` |
| `daily-bookings-report.ts` | Booking velocity analysis | `npx tsx scripts/daily-bookings-report.ts --days 7` |
| `service-usage-report.ts` | Service popularity | `npx tsx scripts/service-usage-report.ts --months 12` |
| `analyze-utilization.ts` | Detailed utilization breakdown | `npx tsx scripts/analyze-utilization.ts` |
| `manage-btb.ts` | BTB block management | `npx tsx scripts/manage-btb.ts` |

### Script Options

**daily-bookings-report.ts**
- `--days N` — Look back N days (default: 7)
- `--new-clients` — Show only new client bookings
- `--state XX` — Filter by state (default: UT)

**service-usage-report.ts**
- `--months N` — Look back N months (default: 12)
- `--state XX` — Filter by state

---

## API Capabilities

The Boulevard library (`lib/boulevard.ts`) provides:

| Function | Description |
|----------|-------------|
| `getLocations()` | List all locations |
| `getStaff(locationId?)` | Get staff members |
| `getShifts(locationId, start, end)` | Get shift schedules |
| `getAppointments(locationId)` | Get appointments |
| `getAppointmentsByCreatedDate()` | Get bookings by when created |
| `getTimeblocks(locationId)` | Get timeblocks (BTB, lunch, DNB) |
| `createTimeblock(input)` | Create a timeblock |
| `deleteTimeblock(id)` | Delete a timeblock |
| `analyzeBTBBlocks()` | Analyze BTB recommendations |
| `executeBTBActions()` | Auto-manage BTB blocks |
| `listWebhooks()` | List webhooks |
| `createWebhook()` | Create webhook |

---

## Decision Frameworks

### When to Add Staff
```
IF shift_utilization > 60% for 4+ weeks
AND location_utilization > 35%
THEN add second aesthetician
```

### When to Cut Shifts
```
IF shift_utilization < 15% for 4+ weeks
AND no seasonal explanation
THEN cut shift or reassign
```

### When to Remove BTB
```
IF shift_utilization > 50%
AND gap_to_first_appointment < 60min
THEN remove BTB block
```

### When to Add BTB
```
IF shift_utilization < 50%
AND gap_at_shift_edge > 90min
THEN add BTB block
```

### When to Acquire
```
IF portfolio_avg_utilization > 40%
AND target_utilization > 25%
AND target_staff_count >= 2
THEN proceed with acquisition
```

### When to Push Marketing
```
IF booking_velocity < -20% vs avg
OR new_clients_per_day < 3
THEN run flash promo or increase spend
```

---

## Key Metrics

### Location Health
| Metric | Target | Red Flag |
|--------|--------|----------|
| Utilization | >40% | <20% |
| Staff count | 3-5 | <2 or >8 |
| Appointments/week | >50 | <20 |

### Booking Velocity
| Metric | Target | Action |
|--------|--------|--------|
| Daily vs avg | >-10% | If <-20%, investigate |
| New clients/day | >5 portfolio | If <3, boost marketing |

### Staff Performance
| Metric | Target | Action |
|--------|--------|--------|
| Util >60% (4wk) | Bottleneck | Add coverage |
| Util <20% (4wk) | Underperforming | Investigate/cut |

---

## File Structure

```
blvd-mcp-server/
├── config/
│   └── utah-locations.json      # Location IDs
├── lib/
│   └── boulevard.ts             # API client
├── scripts/
│   ├── daily-brief-v2.ts        # Daily brief
│   ├── export-portfolio-data.ts # Agent export
│   ├── daily-bookings-report.ts # Velocity
│   └── ...
├── docs/
│   ├── DAILY-BRIEF-PLAN.md      # Full plan
│   └── BLVD-MCP-SERVER.md       # This file
├── exports/                      # Data exports
└── .env                          # API credentials
```

---

## MCP Integration

To use with Claude Desktop or MCP clients, add to config:

```json
{
  "mcpServers": {
    "blvd": {
      "command": "npx",
      "args": ["tsx", "/Users/austin/Dev/blvd-mcp-server/index.ts"],
      "env": {
        "BLVD_API_KEY": "your-key",
        "BLVD_API_SECRET": "your-secret",
        "BLVD_BUSINESS_ID": "your-business-id"
      }
    }
  }
}
```

---

## Environment Variables

Required in `.env`:
```
BLVD_API_KEY=your-api-key
BLVD_API_SECRET=your-api-secret
BLVD_BUSINESS_ID=your-business-id
```

---

## Roadmap

### Phase 1: Core Brief ✅
- Multi-location utilization
- Capacity alerts
- Growth bottleneck detection
- Location leaderboard

### Phase 1.5: Enhanced Brief ✅
- Booking velocity tracking
- New client acquisition
- BTB management recommendations
- Top services by location

### Phase 2: Delivery (Next)
- [ ] Email delivery (6am daily)
- [ ] Slack integration
- [ ] Decision tracking
- [ ] Historical trends

### Phase 3: Advanced Intelligence
- [ ] No-show patterns
- [ ] Rebooking rate tracking
- [ ] Revenue forecasting
- [ ] Staff performance scoring

### Phase 4: Automated Actions
- [ ] Auto-open waitlist at 80%
- [ ] Auto-adjust BTB blocks
- [ ] Bulk shift management

---

## Related

- [[Hello Sugar Utah Operations]]
- [[Boulevard API]]
- [[Salon Utilization Metrics]]

---

*Last updated: 2026-03-22*

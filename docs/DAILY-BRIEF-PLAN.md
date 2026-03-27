# Hello Sugar Utah — Daily AI Operations Brief

## Vision

An AI-powered daily intelligence system that analyzes all Boulevard data across your 7 Utah locations and delivers actionable decisions each morning. The goal: **dominate the Utah market through data-driven micro-optimizations**.

## Your Portfolio

### Owned Locations (7)

**IMPORTANT:** All queries must filter to ONLY these 7 locations. Do NOT use `LIKE 'UT %'` which includes franchises and acquisition targets.

| Location | City | BigQuery Name |
|----------|------|---------------|
| Bountiful | Bountiful | `UT Bountiful \| Colonial Square 042` |
| Farmington | Farmington | `UT Farmington \| Farmington Station 227` |
| Heber City | Heber City | `UT Heber City \| Valley Station 236` |
| Ogden | Riverdale | `UT Ogden \| Riverdale 082` |
| Riverton | Riverton | `UT Riverton \| Mountain View Village 237` |
| Sugar House | Salt Lake City | `UT Salt Lake City \| Sugar House 126` |
| West Valley | West Valley City | `UT West Valley \| Valley Fair 176` |

### Acquisition Targets (4)
*These are NOT owned — do not include in daily brief metrics.*

| Location | City | Target Timeline |
|----------|------|-----------------|
| American Fork | American Fork | 2 years |
| Draper | Draper | 2 years |
| Midvale | Midvale | 2 years |
| Spanish Fork | Spanish Fork | 2 years |

---

## Daily Brief Components (v2)

### 1. Booking Velocity (📈 Leading Indicator)
**What:** Yesterday's new bookings compared to 7-day average + new client acquisition.

**Why This Matters:**
- Utilization tells you where you ARE — velocity tells you where you're GOING
- Catch downturns before they hit your schedule
- Track new client acquisition as growth fuel

**Action Required:**
- If velocity down >20%: Run flash promo, check marketing spend
- If velocity up >30%: Push marketing harder, you have momentum
- Track new clients to ensure rebooking

**Example:**
```
📊 Portfolio: 47 bookings yesterday (+15% vs avg)
🆕 New clients: 8

🚀 Sugar House   12 bookings (+25% vs avg) | 3 new clients
✓  Ogden         8 bookings (+5% vs avg)   | 2 new clients
⚠️ Heber City    2 bookings (-40% vs avg)  | 0 new clients
```

### 2. Capacity Alerts (🔴 Urgent)
**What:** Staff shifts that are ≥75% booked in the next 2 weeks.

**Action Required:**
- Add coverage (schedule another aesthetician)
- Open waitlist for overflow
- Raise prices for peak slots (demand-based pricing)

**Example:**
```
🔴 [Ogden] Shelby is 80% booked Sat 9AM-1PM
   → Add coverage or open waitlist?
```

### 3. Growth Bottlenecks (🟡 This Week)
**What:** Staff consistently hitting 50-74% utilization — they're becoming constraints on growth.

**Action Required:**
- Recruit/train second aesthetician for that slot
- Extend their hours if possible
- Cross-train existing staff to cover

**Example:**
```
🟡 [Sugar House] Abigail — Sun 8AM-2PM: 65%
   → This shift is a growth bottleneck. Add second aesthetician?
```

### 4. BTB Management (⏰ Automation Ready)
**What:** Back-to-back block recommendations based on shift utilization and appointment gaps.

**Action Required:**
- REMOVE BTB when shift is filling up (appointments close to shift edges)
- ADD BTB when large gaps exist (protect aesthetician time)

**Example:**
```
🔓 REMOVE BTB (shift is filling up):
   [Sugar House] Izzy 2026-03-22 start - 45min to first apt

🔒 ADD BTB (large gaps to fill):
   [Ogden] Shelby 2026-03-24 end - 120min gap at shift end
```

### 5. Underutilized Shifts (💤 Cut or Promote)
**What:** Shifts with <20% utilization — wasted payroll or marketing opportunity.

**Action Required:**
- Cut the shift (reduce labor cost)
- Run targeted promos for that time slot
- Reassign staff to busier locations

**Example:**
```
💤 [Riverton] Asya Sun 2PM-8PM: only 5%
   → Cut shift or run Sunday promo?
```

### 6. Top Services (💅 What's Selling)
**What:** Most popular services by location over the last 2 weeks.

**Use For:**
- Ensure you're staffed for high-demand services
- Identify service trends across locations
- Spot upsell opportunities

**Example:**
```
[Sugar House]
• Brazilian Sugaring: 45x
• Underarm Sugaring: 32x
• Full Leg Sugaring: 28x
```

### 7. Location Leaderboard (📊 Portfolio View)
**What:** All 7 locations ranked by utilization with trend indicators.

**Use For:**
- Identify top performers to replicate
- Flag underperformers for investigation
- Track portfolio health over time

**Example:**
```
1. 🟢 Ogden          █████████░ 45%
2. 🟡 Sugar House    ███████░░░ 35%
3. 🔴 Heber City     ██░░░░░░░░ 11%
```

### 8. Acquisition Target Recon (🎯 Competitive Intel)
**What:** Utilization, staff count, and booking velocity for the 4 locations you want to acquire.

**Use For:**
- Gauge operational health before purchase
- Identify struggling locations (negotiation leverage)
- Track changes over time

**Example:**
```
🎯 Draper: 30% util | 3 staff | 5/day bookings | 🟡 Moderate
   → Healthy operation, fair acquisition target
```

### 9. AI Recommendations (🧠 Strategic)
**What:** AI-generated insights based on portfolio analysis.

**Types:**
- Booking velocity alerts (catch trends early)
- Top performer insights (replicate what works)
- Underperformer alerts (investigate root cause)
- Capacity pressure warnings
- New client acquisition tracking
- Portfolio-level guidance (expand vs. consolidate)

---

## How to Use the BLVD MCP Server

### Current Capabilities

| Capability | Command/Tool | Status |
|------------|--------------|--------|
| List all locations | `getLocations()` | ✅ Ready |
| Get staff by location | `getStaff(locationId)` | ✅ Ready |
| Get shifts | `getShifts(locationId, start, end)` | ✅ Ready |
| Get appointments | `getAppointments(locationId)` | ✅ Ready |
| Get appointments by created date | `getAppointmentsByCreatedDate()` | ✅ Ready |
| Get timeblocks | `getTimeblocks(locationId)` | ✅ Ready |
| Create staff member | `createStaff(input)` | ✅ Ready |
| Create timeblock | `createTimeblock(input)` | ✅ Ready |
| Delete timeblock | `deleteTimeblock(id)` | ✅ Ready |
| Calculate utilization | `calculateShiftUtilization()` | ✅ Ready |
| Analyze BTB blocks | `analyzeBTBBlocks()` | ✅ Ready |
| Execute BTB actions | `executeBTBActions()` | ✅ Ready |
| Webhook management | `listWebhooks()`, `createWebhook()` | ✅ Ready |

### Running the Daily Brief

```bash
# From the project directory
cd ~/Dev/blvd-mcp-server

# Run the enhanced daily brief (v2)
npx tsx scripts/daily-brief-v2.ts

# Run the original daily brief
npx tsx scripts/daily-brief.ts
```

### Other Useful Scripts

```bash
# Daily bookings report (last 7 days)
npx tsx scripts/daily-bookings-report.ts --days 7

# New clients only
npx tsx scripts/daily-bookings-report.ts --new-clients

# Service usage report (last 12 months)
npx tsx scripts/service-usage-report.ts --months 12

# Utilization analysis (Sugar House)
npx tsx scripts/analyze-utilization.ts

# BTB management
npx tsx scripts/manage-btb.ts
```

### Configuration

Location config is stored in:
```
config/utah-locations.json
```

To add/remove locations, edit this file.

---

## Implementation Roadmap

### Phase 1: Core Brief (✅ Complete)
- [x] Multi-location utilization analysis
- [x] Capacity alerts (≥75% booked)
- [x] Growth bottleneck detection (≥50%)
- [x] Underutilization flagging (<20%)
- [x] Location leaderboard
- [x] Acquisition target monitoring
- [x] AI recommendations

### Phase 1.5: Enhanced Brief v2 (✅ Complete)
- [x] Booking velocity tracking (yesterday vs. 7-day avg)
- [x] New client acquisition metrics
- [x] BTB management recommendations
- [x] Top services by location
- [x] Enhanced AI recommendations with velocity insights

### Phase 2: Delivery & Automation (Next)
- [ ] Email delivery (6am daily)
- [ ] Slack integration
- [ ] Decision tracking (log Y/N responses)
- [ ] Historical trend storage
- [ ] Automated BTB management via webhooks

### Phase 3: Advanced Intelligence
- [ ] No-show pattern detection
- [ ] Client rebooking rate tracking
- [ ] Revenue forecasting
- [ ] Staff performance scoring
- [ ] Competitor monitoring (if data available)
- [ ] Week-over-week growth tracking
- [ ] Seasonal pattern recognition

### Phase 4: Automated Actions
- [ ] Auto-open waitlist when shift hits 80%
- [ ] Auto-suggest shift changes based on demand
- [ ] Auto-create timeblocks for team meetings
- [ ] Bulk shift management across locations
- [ ] Auto-adjust BTB blocks based on bookings

---

## Key Metrics to Track

### Location Health
| Metric | Target | Red Flag |
|--------|--------|----------|
| Utilization | >40% | <20% |
| Staff count | 3-5 per location | <2 or >8 |
| Appointments/week | >50 | <20 |

### Booking Velocity
| Metric | Target | Action |
|--------|--------|--------|
| Daily bookings vs. avg | >-10% | If <-20%, investigate |
| New clients/day | >5 portfolio | If <3, boost marketing |
| Week-over-week growth | >0% | If <-10%, urgent review |

### Staff Performance
| Metric | Target | Action |
|--------|--------|--------|
| Utilization >60% (4wk avg) | Growth bottleneck | Add coverage |
| Utilization <20% (4wk avg) | Underperforming | Investigate/cut |
| No-show rate >10% | Client issue | Require deposits |

### Portfolio Health
| Metric | Target | Action |
|--------|--------|--------|
| Avg utilization >40% | Ready to expand | Accelerate acquisitions |
| Avg utilization <25% | Focus on ops | Pause expansion |
| Locations >50% util | Growth-ready | Add staff/hours |

---

## Decision Framework

### When to Add Staff
```
IF shift_utilization > 60% for 4+ weeks
AND location_utilization > 35%
THEN add second aesthetician to that shift
```

### When to Cut Shifts
```
IF shift_utilization < 15% for 4+ weeks
AND no seasonal explanation
THEN cut shift or reassign staff
```

### When to Remove BTB
```
IF shift_utilization > 50%
AND gap_to_first_appointment < 60min
THEN remove BTB block to open availability
```

### When to Add BTB
```
IF shift_utilization < 50%
AND gap_at_shift_edge > 90min
AND no existing BTB block
THEN add BTB to protect aesthetician time
```

### When to Acquire
```
IF portfolio_avg_utilization > 40%
AND target_location_utilization > 25%
AND target_staff_count >= 2
THEN proceed with acquisition
```

### When to Push Marketing
```
IF booking_velocity < -20% vs avg
OR new_clients_per_day < 3
THEN run flash promo or increase marketing spend
```

---

## Files & Scripts

```
blvd-mcp-server/
├── config/
│   └── utah-locations.json     # Your 7 owned + 4 targets
├── lib/
│   └── boulevard.ts            # BLVD API client + BTB analysis
├── scripts/
│   ├── daily-brief.ts          # Original daily brief
│   ├── daily-brief-v2.ts       # Enhanced daily brief with velocity
│   ├── daily-bookings-report.ts # Booking velocity analysis
│   ├── service-usage-report.ts  # Service popularity analysis
│   ├── analyze-utilization.ts   # Detailed utilization breakdown
│   └── manage-btb.ts           # BTB block management
├── docs/
│   └── DAILY-BRIEF-PLAN.md     # This file
└── .env                        # API credentials
```

---

## Next Steps

1. **Run the enhanced brief daily** — `npx tsx scripts/daily-brief-v2.ts`
2. **Track decisions** — Note which recommendations you act on
3. **Measure outcomes** — Did adding coverage increase revenue?
4. **Set up automation** — Email delivery at 6am
5. **Iterate** — Tell me what's useful vs. noise, and I'll refine

---

## Support

To modify or extend the daily brief:
```bash
# Edit the enhanced brief script
code ~/Dev/blvd-mcp-server/scripts/daily-brief-v2.ts

# Edit location config
code ~/Dev/blvd-mcp-server/config/utah-locations.json
```

Questions? Just ask — the MCP server can answer queries about any location, staff member, or time period.

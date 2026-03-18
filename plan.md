# Boulevard Operations MCP Server - Plan

## Overview
Internal operations tool for Hello Sugar to monitor shift utilization, manage calendar blocks, and gain insights from Boulevard booking data.

## Goals
1. Monitor shift utilization across locations
2. Proactively surface shifts with >60% utilization over last 4 weeks
3. Manage timeblocks (blocked calendar time) for staff
4. Provide insights on booking patterns and capacity needs

## Architecture
- **Runtime:** Node.js 22+ with mcp-use framework
- **API:** Boulevard Admin GraphQL API (Enterprise tier)
- **Authentication:** Basic auth with API key + Business ID header

## Tools Implemented
| Tool | Purpose | Status |
|------|---------|--------|
| `list-locations` | Get all locations with IDs | Done |
| `get-staff` | Get staff for a location | Done |
| `get-shift-utilization` | Analyze utilization for date range | Done |
| `get-busy-shifts` | Proactive insight - find >60% utilized shifts | Done |
| `list-timeblocks` | View existing calendar blocks | Done |
| `create-timeblock` | Add a block to staff calendar | Done |
| `delete-timeblock` | Remove a calendar block | Done |
| `get-appointments` | View appointments for a location | Done |
| `analyze-btb-blocks` | Preview BTB blocks that would be removed | Done |
| `cleanup-btb-blocks` | Auto-remove BTB blocks based on utilization | Done |

## BTB Auto-Cleanup Feature
Automatically removes BTB (buffer) blocks when:
1. Shift utilization >= threshold (default 50%)
2. Gap between block and first/last appointment < threshold (default 60min)

**Configuration (env vars):**
- `BTB_UTILIZATION_THRESHOLD` - Min utilization % (default: 50)
- `BTB_MIN_GAP_MINUTES` - Gap threshold in minutes (default: 60)
- `BTB_LOOK_AHEAD_DAYS` - Days to analyze (default: 14)

**Webhook endpoint:** `POST /webhook/boulevard`
- Triggered by Boulevard appointment.created events
- Automatically evaluates affected shift and removes qualifying blocks

## Future Enhancements
- [ ] Weekly utilization digest prompt
- [ ] Automatic capacity recommendations
- [ ] Integration with notification systems (Slack, email)
- [ ] Historical trend analysis
- [ ] Revenue correlation with utilization

## Deployment Options
- **Local:** `npm run dev` for development
- **Manufact Cloud:** `npm run deploy` for always-on access
- **Self-hosted:** Docker container on VPS

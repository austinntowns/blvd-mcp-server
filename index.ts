import { MCPServer, object, text, error, markdown } from "mcp-use/server";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  getLocations,
  getStaff,
  getShifts,
  getAppointments,
  getTimeblocks,
  createTimeblock,
  deleteTimeblock,
  calculateShiftUtilization,
  analyzeBTBBlocks,
  executeBTBActions,
  getTimeblocksInRange,
  getServices,
  getService,
  deactivateServiceAtLocation,
  activateServiceAtLocation,
  deactivateServiceBusinessWide,
  activateServiceBusinessWide,
  type ShiftUtilization,
  type BTBCleanupConfig,
  type BTBAnalysisResult,
  type Service,
  DEFAULT_BTB_CONFIG,
} from "./lib/boulevard.js";

// Read enrolled locations
function getEnrolledLocations(): string[] {
  const enrollmentFile = join(import.meta.dirname || ".", "enrolled-locations.json");
  try {
    if (existsSync(enrollmentFile)) {
      const data = JSON.parse(readFileSync(enrollmentFile, "utf-8"));
      return data.locations || [];
    }
  } catch (e) {
    console.error("Error reading enrollment file:", e);
  }
  return [];
}

// Create MCP server instance
const server = new MCPServer({
  name: "blvd-mcp-server",
  title: "Boulevard Operations",
  version: "1.0.0",
  description:
    "Internal operations tool for Hello Sugar - monitor shift utilization, manage calendar blocks, and gain insights from Boulevard",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
});

// ============================================
// LOCATION TOOLS
// ============================================

server.tool(
  {
    name: "list-locations",
    description:
      "List all Boulevard locations for the business. Use this to get location IDs for other queries.",
    schema: z.object({}),
  },
  async () => {
    try {
      const locations = await getLocations();
      return object({
        count: locations.length,
        locations: locations.map((loc) => ({
          id: loc.id,
          name: loc.name,
          address: loc.address
            ? `${loc.address.line1 || ""}, ${loc.address.city || ""}, ${loc.address.state || ""} ${loc.address.zip || ""}`.trim()
            : null,
        })),
      });
    } catch (e) {
      return error(
        `Failed to fetch locations: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "get-staff",
    description: "Get staff members for a specific location",
    schema: z.object({
      locationId: z.string().describe("The Boulevard location ID"),
    }),
  },
  async ({ locationId }) => {
    try {
      const staff = await getStaff(locationId);
      return object({
        count: staff.length,
        staff: staff.map((s) => ({
          id: s.id,
          name: s.displayName || s.name,
          role: s.role?.name || "Staff",
        })),
      });
    } catch (e) {
      return error(
        `Failed to fetch staff: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

// ============================================
// SHIFT UTILIZATION TOOLS
// ============================================

server.tool(
  {
    name: "get-shift-utilization",
    description:
      "Analyze shift utilization for a location over a date range. Shows how busy each shift was based on booked appointments.",
    schema: z.object({
      locationId: z.string().describe("The Boulevard location ID"),
      startDate: z
        .string()
        .describe("Start date in YYYY-MM-DD format (e.g., 2024-01-01)"),
      endDate: z
        .string()
        .describe("End date in YYYY-MM-DD format (e.g., 2024-01-31)"),
      staffIds: z
        .array(z.string())
        .optional()
        .describe("Optional: Filter to specific staff member IDs"),
    }),
  },
  async ({ locationId, startDate, endDate, staffIds }) => {
    try {
      // Get shifts and appointments for the period
      const [shifts, appointments] = await Promise.all([
        getShifts(locationId, startDate, endDate, staffIds),
        getAppointments(locationId, startDate, endDate),
      ]);

      // Calculate utilization for each shift
      const utilizations: ShiftUtilization[] = shifts.map((shift) =>
        calculateShiftUtilization(shift, appointments)
      );

      // Sort by utilization (highest first)
      utilizations.sort((a, b) => b.utilizationPercent - a.utilizationPercent);

      return object({
        period: { startDate, endDate },
        totalShifts: shifts.length,
        totalAppointments: appointments.length,
        shifts: utilizations.map((u) => ({
          staffName: u.shift.staffMember.displayName || u.shift.staffMember.name,
          staffId: u.shift.staffId,
          date: u.shift.date,
          startTime: new Date(u.shift.startAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          endTime: new Date(u.shift.endAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          availableMinutes: u.availableMinutes,
          bookedMinutes: u.bookedMinutes,
          utilizationPercent: u.utilizationPercent,
          appointmentCount: u.appointments.length,
        })),
      });
    } catch (e) {
      return error(
        `Failed to analyze utilization: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "get-busy-shifts",
    description:
      "PROACTIVE INSIGHT: Find shifts with high utilization (>60% by default) over the last 4 weeks. Use this to identify where you need to add more staff capacity.",
    schema: z.object({
      locationId: z.string().describe("The Boulevard location ID"),
      utilizationThreshold: z
        .number()
        .default(60)
        .describe(
          "Minimum utilization percentage to flag as busy (default: 60)"
        ),
      weeksBack: z
        .number()
        .default(4)
        .describe("Number of weeks to analyze (default: 4)"),
    }),
  },
  async ({ locationId, utilizationThreshold, weeksBack }) => {
    try {
      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - weeksBack * 7);

      const startDateStr = startDate.toISOString().split("T")[0];
      const endDateStr = endDate.toISOString().split("T")[0];

      // Get shifts and appointments
      const [shifts, appointments] = await Promise.all([
        getShifts(locationId, startDateStr, endDateStr),
        getAppointments(locationId, startDateStr, endDateStr),
      ]);

      // Calculate utilization and filter to busy shifts
      const utilizations = shifts
        .map((shift) => calculateShiftUtilization(shift, appointments))
        .filter((u) => u.utilizationPercent >= utilizationThreshold);

      // Group by day of week and time slot to find patterns
      const patternMap = new Map<
        string,
        { count: number; avgUtil: number; shifts: ShiftUtilization[] }
      >();

      for (const u of utilizations) {
        const date = new Date(u.shift.startAt);
        const dayOfWeek = date.toLocaleDateString("en-US", { weekday: "long" });
        const hour = date.getHours();
        const timeSlot = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
        const key = `${dayOfWeek} ${timeSlot}`;

        const existing = patternMap.get(key) || {
          count: 0,
          avgUtil: 0,
          shifts: [],
        };
        existing.count++;
        existing.shifts.push(u);
        existing.avgUtil =
          existing.shifts.reduce((sum, s) => sum + s.utilizationPercent, 0) /
          existing.shifts.length;
        patternMap.set(key, existing);
      }

      // Convert to sorted array
      const patterns = Array.from(patternMap.entries())
        .map(([slot, data]) => ({
          timeSlot: slot,
          occurrences: data.count,
          averageUtilization: Math.round(data.avgUtil * 10) / 10,
        }))
        .sort((a, b) => b.occurrences - a.occurrences);

      // Build markdown report
      let report = `## Busy Shift Analysis\n\n`;
      report += `**Period:** ${startDateStr} to ${endDateStr} (${weeksBack} weeks)\n`;
      report += `**Threshold:** ${utilizationThreshold}%+ utilization\n`;
      report += `**Total Busy Shifts:** ${utilizations.length} of ${shifts.length} shifts\n\n`;

      if (patterns.length > 0) {
        report += `### Recurring Patterns (need more staff)\n\n`;
        report += `| Time Slot | Occurrences | Avg Utilization |\n`;
        report += `|-----------|-------------|------------------|\n`;
        for (const p of patterns.slice(0, 10)) {
          report += `| ${p.timeSlot} | ${p.occurrences} | ${p.averageUtilization}% |\n`;
        }
        report += `\n`;
      }

      if (utilizations.length > 0) {
        report += `### Top 10 Busiest Shifts\n\n`;
        const top10 = utilizations
          .sort((a, b) => b.utilizationPercent - a.utilizationPercent)
          .slice(0, 10);

        report += `| Date | Staff | Time | Utilization |\n`;
        report += `|------|-------|------|-------------|\n`;
        for (const u of top10) {
          const date = new Date(u.shift.startAt);
          report += `| ${date.toLocaleDateString()} | ${u.shift.staffMember.displayName || u.shift.staffMember.name} | ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} | ${u.utilizationPercent}% |\n`;
        }
      }

      return markdown(report);
    } catch (e) {
      return error(
        `Failed to analyze busy shifts: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

// ============================================
// TIMEBLOCK MANAGEMENT TOOLS
// ============================================

server.tool(
  {
    name: "list-timeblocks",
    description: "List existing timeblocks (blocked time) for a location",
    schema: z.object({
      locationId: z.string().describe("The Boulevard location ID"),
      staffId: z
        .string()
        .optional()
        .describe("Optional: Filter to a specific staff member"),
    }),
  },
  async ({ locationId, staffId }) => {
    try {
      const timeblocks = await getTimeblocks(locationId, staffId);
      return object({
        count: timeblocks.length,
        timeblocks: timeblocks.map((tb) => ({
          id: tb.id,
          title: tb.title || "(No title)",
          reason: tb.reason,
          staffName: tb.staff?.name || "Unknown",
          staffId: tb.staff?.id,
          startAt: tb.startAt,
          endAt: tb.endAt,
          duration: tb.duration,
        })),
      });
    } catch (e) {
      return error(
        `Failed to fetch timeblocks: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "create-timeblock",
    description:
      "Create a timeblock (blocked time) on a staff member's calendar. Use this to block time when a staff member is unavailable.",
    schema: z.object({
      locationId: z.string().describe("The Boulevard location ID"),
      staffId: z.string().describe("The staff member's ID"),
      startTime: z
        .string()
        .describe("Start time in ISO 8601 format (e.g., 2024-01-15T09:00:00)"),
      duration: z.number().describe("Duration in minutes"),
      title: z
        .string()
        .optional()
        .describe("Optional title for the block (e.g., 'Lunch', 'Training')"),
      reason: z
        .string()
        .optional()
        .describe("Optional reason code for the block"),
    }),
  },
  async ({ locationId, staffId, startTime, duration, title, reason }) => {
    try {
      const timeblock = await createTimeblock({
        locationId,
        staffId,
        startTime,
        duration,
        title,
        reason,
      });
      return object({
        success: true,
        timeblock: {
          id: timeblock.id,
          title: timeblock.title,
          startAt: timeblock.startAt,
          endAt: timeblock.endAt,
          duration: timeblock.duration,
          staffName: timeblock.staff?.name,
        },
      });
    } catch (e) {
      return error(
        `Failed to create timeblock: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "delete-timeblock",
    description: "Delete a timeblock from the calendar",
    schema: z.object({
      timeblockId: z.string().describe("The ID of the timeblock to delete"),
    }),
  },
  async ({ timeblockId }) => {
    try {
      await deleteTimeblock(timeblockId);
      return object({
        success: true,
        message: `Timeblock ${timeblockId} deleted successfully`,
      });
    } catch (e) {
      return error(
        `Failed to delete timeblock: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

// ============================================
// BTB AUTO-CLEANUP TOOLS
// ============================================

server.tool(
  {
    name: "analyze-btb-blocks",
    description:
      "Analyze BTB (buffer) blocks across locations to see which ones should be removed based on utilization and appointment gaps. Does NOT delete - just shows analysis.",
    schema: z.object({
      locationIds: z
        .array(z.string())
        .optional()
        .describe("Location IDs to analyze. If not provided, analyzes all locations."),
      utilizationThreshold: z
        .number()
        .default(50)
        .describe("Minimum utilization % to consider removing blocks (default: 50)"),
      minGapMinutes: z
        .number()
        .default(60)
        .describe("Gap threshold in minutes - remove block if gap to appointment is less than this (default: 60)"),
      lookAheadDays: z
        .number()
        .default(14)
        .describe("Number of days ahead to analyze (default: 14)"),
    }),
  },
  async ({ locationIds, utilizationThreshold, minGapMinutes, lookAheadDays }) => {
    try {
      const config: BTBCleanupConfig = {
        utilizationThreshold,
        minGapMinutes,
        lookAheadDays,
        emptyWindowMinutes: 120,
        btbDurationMinutes: 60,
        autoAddGapMinutes: 90,
        autoAddBtbDuration: 30,
      };

      // Get locations to analyze
      let locations = await getLocations();
      if (locationIds && locationIds.length > 0) {
        locations = locations.filter((loc) => locationIds.includes(loc.id));
      }

      const today = new Date();
      const startDate = today.toISOString().split("T")[0];
      const endDate = new Date(today.getTime() + lookAheadDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const allResults: {
        location: string;
        locationId: string;
        analyses: BTBAnalysisResult[];
      }[] = [];

      for (const location of locations) {
        // Get shifts, appointments, and timeblocks for this location
        const [shifts, appointments, timeblocks] = await Promise.all([
          getShifts(location.id, startDate, endDate),
          getAppointments(location.id, startDate, endDate),
          getTimeblocksInRange(location.id, startDate, endDate),
        ]);

        // Analyze each shift
        const analyses = shifts
          .map((shift) => analyzeBTBBlocks(shift, appointments, timeblocks, config))
          .filter((a) => a.startBlock || a.endBlock); // Only include shifts with BTB blocks

        if (analyses.length > 0) {
          allResults.push({
            location: location.name,
            locationId: location.id,
            analyses,
          });
        }
      }

      // Build report
      let report = `## BTB Block Analysis\n\n`;
      report += `**Period:** ${startDate} to ${endDate} (${lookAheadDays} days)\n`;
      report += `**Config:** ${utilizationThreshold}% utilization threshold, ${minGapMinutes}min gap threshold\n\n`;

      let totalToRemove = 0;
      const blocksToRemove: { id: string; location: string; staff: string; type: string; date: string }[] = [];

      for (const locResult of allResults) {
        const locBlocksToRemove = locResult.analyses.filter(
          (a) => a.startBlockShouldRemove || a.endBlockShouldRemove
        );

        if (locBlocksToRemove.length > 0) {
          report += `### ${locResult.location}\n\n`;
          report += `| Date | Staff | Util% | Start Block | End Block |\n`;
          report += `|------|-------|-------|-------------|------------|\n`;

          for (const analysis of locResult.analyses) {
            if (!analysis.startBlockShouldRemove && !analysis.endBlockShouldRemove) continue;

            const date = analysis.shift.startAt.split("T")[0];
            const staffName = analysis.shift.staffMember.displayName || analysis.shift.staffMember.name;

            let startStatus = "-";
            if (analysis.startBlock) {
              if (analysis.startBlockShouldRemove) {
                startStatus = `⚠️ REMOVE (${analysis.startGapMinutes}min gap)`;
                blocksToRemove.push({
                  id: analysis.startBlock.id,
                  location: locResult.location,
                  staff: staffName,
                  type: "start",
                  date,
                });
                totalToRemove++;
              } else {
                startStatus = `OK (${analysis.startGapMinutes ?? ">60"}min gap)`;
              }
            }

            let endStatus = "-";
            if (analysis.endBlock) {
              if (analysis.endBlockShouldRemove) {
                endStatus = `⚠️ REMOVE (${analysis.endGapMinutes}min gap)`;
                blocksToRemove.push({
                  id: analysis.endBlock.id,
                  location: locResult.location,
                  staff: staffName,
                  type: "end",
                  date,
                });
                totalToRemove++;
              } else {
                endStatus = `OK (${analysis.endGapMinutes ?? ">60"}min gap)`;
              }
            }

            report += `| ${date} | ${staffName} | ${analysis.utilizationPercent}% | ${startStatus} | ${endStatus} |\n`;
          }
          report += `\n`;
        }
      }

      if (totalToRemove === 0) {
        report += `\n✅ **No BTB blocks need to be removed at this time.**\n`;
      } else {
        report += `\n### Summary\n\n`;
        report += `**${totalToRemove} BTB blocks recommended for removal**\n\n`;
        report += `Use \`cleanup-btb-blocks\` to automatically remove these blocks.\n`;
      }

      return markdown(report);
    } catch (e) {
      return error(
        `Failed to analyze BTB blocks: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "cleanup-btb-blocks",
    description:
      "Automatically remove BTB blocks that meet removal criteria (high utilization + small gap to appointments). This WILL delete timeblocks.",
    schema: z.object({
      locationIds: z
        .array(z.string())
        .optional()
        .describe("Location IDs to process. If not provided, processes all locations."),
      utilizationThreshold: z
        .number()
        .default(50)
        .describe("Minimum utilization % to consider removing blocks (default: 50)"),
      minGapMinutes: z
        .number()
        .default(60)
        .describe("Gap threshold in minutes - remove block if gap to appointment is less than this (default: 60)"),
      lookAheadDays: z
        .number()
        .default(14)
        .describe("Number of days ahead to process (default: 14)"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("If true, only report what would be deleted without actually deleting"),
    }),
  },
  async ({ locationIds, utilizationThreshold, minGapMinutes, lookAheadDays, dryRun }) => {
    try {
      const config: BTBCleanupConfig = {
        utilizationThreshold,
        minGapMinutes,
        lookAheadDays,
        emptyWindowMinutes: 120,
        btbDurationMinutes: 60,
        autoAddGapMinutes: 90,
        autoAddBtbDuration: 30,
      };

      // Get locations to process
      let locations = await getLocations();
      if (locationIds && locationIds.length > 0) {
        locations = locations.filter((loc) => locationIds.includes(loc.id));
      }

      const today = new Date();
      const startDate = today.toISOString().split("T")[0];
      const endDate = new Date(today.getTime() + lookAheadDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const deletedBlocks: {
        id: string;
        location: string;
        staff: string;
        type: "start" | "end";
        date: string;
        utilization: number;
        gapMinutes: number;
      }[] = [];

      const errors: string[] = [];

      for (const location of locations) {
        // Get shifts, appointments, and timeblocks for this location
        const [shifts, appointments, timeblocks] = await Promise.all([
          getShifts(location.id, startDate, endDate),
          getAppointments(location.id, startDate, endDate),
          getTimeblocksInRange(location.id, startDate, endDate),
        ]);

        // Analyze each shift
        for (const shift of shifts) {
          const analysis = analyzeBTBBlocks(shift, appointments, timeblocks, config);
          const staffName = shift.staffMember.displayName || shift.staffMember.name;
          const date = shift.startAt.split("T")[0];

          // Delete start block if needed
          if (analysis.startBlockShouldRemove && analysis.startBlock) {
            if (!dryRun) {
              try {
                await deleteTimeblock(analysis.startBlock.id);
              } catch (e) {
                errors.push(
                  `Failed to delete start block for ${staffName} on ${date}: ${e instanceof Error ? e.message : "Unknown"}`
                );
                continue;
              }
            }
            deletedBlocks.push({
              id: analysis.startBlock.id,
              location: location.name,
              staff: staffName,
              type: "start",
              date,
              utilization: analysis.utilizationPercent,
              gapMinutes: analysis.startGapMinutes || 0,
            });
          }

          // Delete end block if needed
          if (analysis.endBlockShouldRemove && analysis.endBlock) {
            if (!dryRun) {
              try {
                await deleteTimeblock(analysis.endBlock.id);
              } catch (e) {
                errors.push(
                  `Failed to delete end block for ${staffName} on ${date}: ${e instanceof Error ? e.message : "Unknown"}`
                );
                continue;
              }
            }
            deletedBlocks.push({
              id: analysis.endBlock.id,
              location: location.name,
              staff: staffName,
              type: "end",
              date,
              utilization: analysis.utilizationPercent,
              gapMinutes: analysis.endGapMinutes || 0,
            });
          }
        }
      }

      // Build result
      let report = dryRun
        ? `## BTB Cleanup - DRY RUN\n\n`
        : `## BTB Cleanup Results\n\n`;

      report += `**Period:** ${startDate} to ${endDate}\n`;
      report += `**Config:** ${utilizationThreshold}% threshold, ${minGapMinutes}min gap\n\n`;

      if (deletedBlocks.length === 0) {
        report += `✅ No BTB blocks needed removal.\n`;
      } else {
        report += dryRun
          ? `### Blocks that WOULD be removed (${deletedBlocks.length})\n\n`
          : `### Blocks removed (${deletedBlocks.length})\n\n`;

        report += `| Location | Date | Staff | Type | Util% | Gap |\n`;
        report += `|----------|------|-------|------|-------|-----|\n`;

        for (const block of deletedBlocks) {
          report += `| ${block.location} | ${block.date} | ${block.staff} | ${block.type} | ${block.utilization}% | ${block.gapMinutes}min |\n`;
        }
      }

      if (errors.length > 0) {
        report += `\n### Errors\n\n`;
        for (const err of errors) {
          report += `- ${err}\n`;
        }
      }

      return markdown(report);
    } catch (e) {
      return error(
        `Failed to cleanup BTB blocks: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

// ============================================
// APPOINTMENTS TOOL
// ============================================

server.tool(
  {
    name: "get-appointments",
    description: "Get appointments for a location within a date range",
    schema: z.object({
      locationId: z.string().describe("The Boulevard location ID"),
      startDate: z
        .string()
        .optional()
        .describe("Start date in YYYY-MM-DD format"),
      endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
      staffId: z
        .string()
        .optional()
        .describe("Optional: Filter to a specific staff member"),
      limit: z
        .number()
        .default(50)
        .describe("Maximum appointments to return (default: 50)"),
    }),
  },
  async ({ locationId, startDate, endDate, staffId, limit }) => {
    try {
      const appointments = await getAppointments(
        locationId,
        startDate,
        endDate,
        staffId,
        limit
      );
      return object({
        count: appointments.length,
        appointments: appointments.map((apt) => ({
          id: apt.id,
          date: apt.startAt.split("T")[0],
          startTime: new Date(apt.startAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          endTime: new Date(apt.endAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          duration: apt.duration,
          state: apt.state,
          services:
            apt.appointmentServices?.map((svc) => ({
              name: svc.service?.name,
              staffName: svc.staff?.name,
              duration: svc.duration,
            })) || [],
        })),
      });
    } catch (e) {
      return error(
        `Failed to fetch appointments: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

// ============================================
// SERVICE MANAGEMENT TOOLS
// ============================================

server.tool(
  {
    name: "list-services",
    description:
      "List all services in Boulevard. Returns service ID, name, active status, duration, and price.",
    schema: z.object({
      activeOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, only return active services"),
    }),
  },
  async ({ activeOnly }) => {
    try {
      let services = await getServices();
      if (activeOnly) {
        services = services.filter((s) => s.active);
      }
      return object({
        count: services.length,
        services: services.map((svc) => ({
          id: svc.id,
          name: svc.name,
          active: svc.active,
          duration: svc.defaultDuration,
          price: svc.defaultPrice,
          category: svc.category?.name || null,
        })),
      });
    } catch (e) {
      return error(
        `Failed to fetch services: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "get-service",
    description: "Get details for a specific service by ID",
    schema: z.object({
      serviceId: z.string().describe("The Boulevard service ID (e.g., urn:blvd:Service:...)"),
    }),
  },
  async ({ serviceId }) => {
    try {
      const service = await getService(serviceId);
      if (!service) {
        return error(`Service not found: ${serviceId}`);
      }
      return object({
        id: service.id,
        name: service.name,
        active: service.active,
        duration: service.defaultDuration,
        price: service.defaultPrice,
        category: service.category?.name || null,
      });
    } catch (e) {
      return error(
        `Failed to fetch service: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "deactivate-service",
    description:
      "Deactivate a service at ALL locations in Boulevard, making it unavailable for new bookings. CAUTION: This affects all locations business-wide.",
    schema: z.object({
      serviceId: z.string().describe("The Boulevard service ID (e.g., urn:blvd:Service:...)"),
      confirm: z
        .boolean()
        .describe("Must be true to confirm deactivation. This is a safety check."),
    }),
  },
  async ({ serviceId, confirm }) => {
    if (!confirm) {
      return error("Deactivation not confirmed. Set confirm=true to proceed.");
    }
    try {
      // Get the service first to show what we're deactivating
      const before = await getService(serviceId);
      if (!before) {
        return error(`Service not found: ${serviceId}`);
      }

      const result = await deactivateServiceBusinessWide(serviceId);
      return object({
        message: `Deactivated service "${before.name}" at ${result.deactivatedAt.length} locations`,
        service: {
          id: before.id,
          name: before.name,
        },
        deactivatedAt: result.deactivatedAt,
        errorsCount: result.errors.length,
        errors: result.errors.slice(0, 5), // Show first 5 errors if any
      });
    } catch (e) {
      return error(
        `Failed to deactivate service: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

server.tool(
  {
    name: "activate-service",
    description: "Activate a service at ALL locations in Boulevard.",
    schema: z.object({
      serviceId: z.string().describe("The Boulevard service ID (e.g., urn:blvd:Service:...)"),
      confirm: z
        .boolean()
        .describe("Must be true to confirm activation. This is a safety check."),
    }),
  },
  async ({ serviceId, confirm }) => {
    if (!confirm) {
      return error("Activation not confirmed. Set confirm=true to proceed.");
    }
    try {
      const before = await getService(serviceId);
      if (!before) {
        return error(`Service not found: ${serviceId}`);
      }

      const result = await activateServiceBusinessWide(serviceId);
      return object({
        message: `Activated service "${before.name}" at ${result.activatedAt.length} locations`,
        service: {
          id: before.id,
          name: before.name,
        },
        activatedAt: result.activatedAt,
        errorsCount: result.errors.length,
        errors: result.errors.slice(0, 5),
      });
    } catch (e) {
      return error(
        `Failed to activate service: ${e instanceof Error ? e.message : "Unknown error"}`
      );
    }
  }
);

// ============================================
// CONFIGURATION RESOURCE
// ============================================

server.resource(
  {
    name: "blvd-config",
    uri: "config://boulevard",
    description:
      "Boulevard connection status and configuration. Check if credentials are properly configured.",
  },
  async () => {
    const hasApiKey = !!process.env.BLVD_API_KEY;
    const hasBusinessId = !!process.env.BLVD_BUSINESS_ID;

    return object({
      configured: hasApiKey && hasBusinessId,
      apiKeySet: hasApiKey,
      businessIdSet: hasBusinessId,
      apiUrl:
        process.env.BLVD_API_URL ||
        "https://dashboard.boulevard.io/api/2020-01/admin",
      message:
        hasApiKey && hasBusinessId
          ? "Boulevard API is configured and ready"
          : "Missing credentials - set BLVD_API_KEY and BLVD_BUSINESS_ID environment variables",
    });
  }
);

// ============================================
// WEBHOOK ENDPOINT FOR AUTO-CLEANUP
// ============================================

// Boulevard webhook handler for appointment events
// Only REMOVES BTB blocks when new bookings increase utilization
// Adding BTB blocks is done separately via scheduled jobs
server.app.post("/webhook/boulevard", async (c) => {
  try {
    const body = await c.req.json();

    // Verify this is an appointment event
    const eventType = body?.event || body?.type;
    if (!eventType?.includes("appointment")) {
      return c.json({ status: "ignored", reason: "not an appointment event" });
    }

    // Extract appointment data
    const appointment = body?.data?.appointment || body?.appointment || body?.data;
    if (!appointment) {
      return c.json({ status: "ignored", reason: "no appointment data" });
    }

    const locationId = appointment.locationId || appointment.location?.id;
    if (!locationId) {
      return c.json({ status: "ignored", reason: "no location ID" });
    }

    // Check if location is enrolled
    const enrolledLocations = getEnrolledLocations();
    if (!enrolledLocations.includes(locationId)) {
      return c.json({ status: "ignored", reason: "location not enrolled" });
    }

    // Get the staff ID from the appointment to only check their shift
    const staffId = appointment.appointmentServices?.[0]?.staff?.id ||
                    appointment.staffId ||
                    appointment.staff?.id;

    // Get config from environment or defaults
    const config: BTBCleanupConfig = {
      ...DEFAULT_BTB_CONFIG,
      utilizationThreshold: parseInt(process.env.BTB_UTILIZATION_THRESHOLD || "50"),
      minGapMinutes: parseInt(process.env.BTB_MIN_GAP_MINUTES || "60"),
      lookAheadDays: parseInt(process.env.BTB_LOOK_AHEAD_DAYS || "14"),
      emptyWindowMinutes: parseInt(process.env.BTB_EMPTY_WINDOW_MINUTES || "120"),
      btbDurationMinutes: parseInt(process.env.BTB_DURATION_MINUTES || "60"),
    };

    // Calculate date range for this appointment's day
    const appointmentDate = new Date(appointment.startAt);
    const startDate = appointmentDate.toISOString().split("T")[0];
    const endDate = startDate; // Just check this day

    // Get shifts, appointments, and timeblocks for this location/day
    // Filter to just the staff member who got the booking if we have their ID
    const [shifts, appointments, timeblocks] = await Promise.all([
      getShifts(locationId, startDate, endDate, staffId ? [staffId] : undefined),
      getAppointments(locationId, startDate, endDate),
      getTimeblocksInRange(locationId, startDate, endDate),
    ]);

    const deletedBlocks: string[] = [];
    const errors: string[] = [];

    // Analyze and remove BTB blocks for each shift (REMOVAL ONLY - no adding)
    for (const shift of shifts) {
      const analysis = analyzeBTBBlocks(shift, appointments, timeblocks, config);
      const staffName = shift.staffMember.displayName || shift.staffMember.name;

      // Only process removals, not additions
      if (analysis.startBlockShouldRemove && analysis.startBlock) {
        try {
          await deleteTimeblock(analysis.startBlock.id);
          deletedBlocks.push(
            `${staffName} start BTB (${analysis.startGapMinutes}min gap, ${analysis.utilizationPercent}% util)`
          );
        } catch (e) {
          errors.push(`Failed to remove ${staffName} start BTB: ${e instanceof Error ? e.message : "Unknown"}`);
        }
      }

      if (analysis.endBlockShouldRemove && analysis.endBlock) {
        try {
          await deleteTimeblock(analysis.endBlock.id);
          deletedBlocks.push(
            `${staffName} end BTB (${analysis.endGapMinutes}min gap, ${analysis.utilizationPercent}% util)`
          );
        } catch (e) {
          errors.push(`Failed to remove ${staffName} end BTB: ${e instanceof Error ? e.message : "Unknown"}`);
        }
      }
    }

    return c.json({
      status: "processed",
      locationId,
      date: startDate,
      staffId: staffId || "all",
      shiftsChecked: shifts.length,
      blocksRemoved: deletedBlocks.length,
      removed: deletedBlocks,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (e) {
    console.error("Webhook error:", e);
    return c.json(
      { status: "error", message: e instanceof Error ? e.message : "Unknown error" },
      500
    );
  }
});

// Health check endpoint
server.app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "blvd-mcp-server",
    btbConfig: {
      utilizationThreshold: process.env.BTB_UTILIZATION_THRESHOLD || "50",
      minGapMinutes: process.env.BTB_MIN_GAP_MINUTES || "60",
      lookAheadDays: process.env.BTB_LOOK_AHEAD_DAYS || "14",
    },
  });
});

// ============================================
// BTB ADMIN UI
// ============================================

// API: List all locations
server.app.get("/api/locations", async (c) => {
  try {
    const locations = await getLocations();
    return c.json({
      locations: locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
      })),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// API: Run BTB bootstrap for selected locations
server.app.post("/api/btb/bootstrap", async (c) => {
  try {
    const body = await c.req.json();
    const { locationIds, dryRun = true } = body;

    if (!locationIds || !Array.isArray(locationIds) || locationIds.length === 0) {
      return c.json({ error: "No locations selected" }, 400);
    }

    const config: BTBCleanupConfig = {
      ...DEFAULT_BTB_CONFIG,
      utilizationThreshold: Number(process.env.BTB_UTILIZATION_THRESHOLD) || 50,
      minGapMinutes: Number(process.env.BTB_MIN_GAP_MINUTES) || 60,
      emptyWindowMinutes: Number(process.env.BTB_EMPTY_WINDOW_MINUTES) || 120,
      btbDurationMinutes: Number(process.env.BTB_DURATION_MINUTES) || 60,
      lookAheadDays: 14,
    };

    const MIN_SHIFT_HOURS = 4;

    // Get selected locations
    const allLocations = await getLocations();
    const locations = allLocations.filter((l) => locationIds.includes(l.id));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Generate all 14 days
    const datesToProcess: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      datesToProcess.push(d.toISOString().split("T")[0]);
    }

    const results: {
      location: string;
      added: string[];
      skipped: number;
      errors: string[];
    }[] = [];

    for (const location of locations) {
      const locationResult = {
        location: location.name,
        added: [] as string[],
        skipped: 0,
        errors: [] as string[],
      };

      try {
        // Get all timeblocks for overlap detection
        const allTimeblocks = await getTimeblocks(location.id);

        for (const date of datesToProcess) {
          try {
            const [shifts, appointments] = await Promise.all([
              getShifts(location.id, date, date),
              getAppointments(location.id, date, date),
            ]);

            if (shifts.length === 0) continue;

            const dateTimeblocks = allTimeblocks.filter((tb) => tb.startAt.includes(date));

            for (const shift of shifts) {
              // Skip short shifts (< 4 hours)
              const shiftStart = new Date(shift.startAt);
              const shiftEnd = new Date(shift.endAt);
              const shiftDurationHours = (shiftEnd.getTime() - shiftStart.getTime()) / (1000 * 60 * 60);

              if (shiftDurationHours < MIN_SHIFT_HOURS) {
                continue;
              }

              const analysis = analyzeBTBBlocks(shift, appointments, dateTimeblocks, config);
              const staffName = shift.staffMember.displayName || shift.staffMember.name;

              if (!analysis.startBlockShouldAdd && !analysis.endBlockShouldAdd) continue;

              if (dryRun) {
                // Check overlaps for accurate dry-run counts
                const staffId = shift.staffMember.id.replace("urn:blvd:Staff:", "");
                const wouldOverlap = (proposedStart: Date, durationMin: number): boolean => {
                  const proposedEnd = proposedStart.getTime() + durationMin * 60 * 1000;
                  return allTimeblocks.some((tb) => {
                    const tbStaffId = tb.staff?.id?.replace("urn:blvd:Staff:", "") || "";
                    if (tbStaffId !== staffId) return false;
                    const tbStart = new Date(tb.startAt).getTime();
                    const tbEnd = new Date(tb.endAt).getTime();
                    return proposedStart.getTime() < tbEnd && proposedEnd > tbStart;
                  });
                };

                if (analysis.startBlockShouldAdd) {
                  if (wouldOverlap(shiftStart, config.btbDurationMinutes)) {
                    locationResult.skipped++;
                  } else {
                    locationResult.added.push(`${date} ${staffName}: start BTB`);
                  }
                }
                if (analysis.endBlockShouldAdd) {
                  const startTime = new Date(shiftEnd.getTime() - config.btbDurationMinutes * 60 * 1000);
                  if (wouldOverlap(startTime, config.btbDurationMinutes)) {
                    locationResult.skipped++;
                  } else {
                    locationResult.added.push(`${date} ${staffName}: end BTB`);
                  }
                }
              } else {
                const result = await executeBTBActions(analysis, config, allTimeblocks);
                for (const added of result.added) {
                  locationResult.added.push(`${date}: ${added}`);
                }
                for (const err of result.errors) {
                  locationResult.errors.push(`${date}: ${err}`);
                }
                const recommended = (analysis.startBlockShouldAdd ? 1 : 0) + (analysis.endBlockShouldAdd ? 1 : 0);
                locationResult.skipped += recommended - result.added.length;
              }
            }
          } catch (e: any) {
            if (e.message?.includes("API limit")) {
              locationResult.errors.push(`${date}: Rate limited`);
            } else {
              locationResult.errors.push(`${date}: ${e.message}`);
            }
          }
        }
      } catch (e: any) {
        locationResult.errors.push(`Failed to fetch data: ${e.message}`);
      }

      results.push(locationResult);
    }

    return c.json({
      mode: dryRun ? "dry-run" : "execute",
      dates: `${datesToProcess[0]} to ${datesToProcess[datesToProcess.length - 1]}`,
      results,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});

// BTB Admin UI page
server.app.get("/btb-admin", (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BTB Manager - Hello Sugar</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #333; margin-bottom: 20px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h2 { color: #666; font-size: 14px; text-transform: uppercase; margin-bottom: 15px; }
    .locations { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
    .location { display: flex; align-items: center; padding: 10px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; transition: all 0.2s; }
    .location:hover { border-color: #007bff; background: #f8f9fa; }
    .location.selected { border-color: #007bff; background: #e7f1ff; }
    .location input { margin-right: 10px; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { padding: 12px 24px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; transition: all 0.2s; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #007bff; color: white; }
    .btn-primary:hover:not(:disabled) { background: #0056b3; }
    .btn-success { background: #28a745; color: white; }
    .btn-success:hover:not(:disabled) { background: #1e7e34; }
    .btn-secondary { background: #6c757d; color: white; }
    .btn-secondary:hover:not(:disabled) { background: #545b62; }
    .results { margin-top: 20px; }
    .result-item { padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px; }
    .result-item h3 { color: #333; margin-bottom: 10px; }
    .result-item .added { color: #28a745; }
    .result-item .skipped { color: #ffc107; }
    .result-item .error { color: #dc3545; }
    .result-list { list-style: none; font-size: 13px; max-height: 200px; overflow-y: auto; }
    .result-list li { padding: 4px 0; border-bottom: 1px solid #eee; }
    .loading { display: none; align-items: center; gap: 10px; color: #666; }
    .loading.active { display: flex; }
    .spinner { width: 20px; height: 20px; border: 2px solid #ddd; border-top-color: #007bff; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .select-all { margin-bottom: 10px; }
    .summary { background: #e9ecef; padding: 10px; border-radius: 4px; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>BTB Block Manager</h1>

    <div class="card">
      <h2>Select Locations</h2>
      <div class="select-all">
        <label><input type="checkbox" id="selectAll"> Select All</label>
      </div>
      <div class="locations" id="locations">
        <div class="loading active" id="loadingLocations">
          <div class="spinner"></div>
          <span>Loading locations...</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Actions</h2>
      <p style="color: #666; margin-bottom: 15px;">Bootstrap adds BTB blocks for the next 14 days on shifts with &lt;50% utilization and no appointments in the first/last 2 hours.</p>
      <div class="actions">
        <button class="btn-primary" id="dryRunBtn" disabled>Dry Run (Preview)</button>
        <button class="btn-success" id="executeBtn" disabled>Execute (Add Blocks)</button>
      </div>
      <div class="loading" id="loadingAction">
        <div class="spinner"></div>
        <span id="loadingText">Processing...</span>
      </div>
    </div>

    <div class="card" id="resultsCard" style="display: none;">
      <h2>Results</h2>
      <div class="summary" id="summary"></div>
      <div class="results" id="results"></div>
    </div>
  </div>

  <script>
    let locations = [];
    let selectedLocations = new Set();

    async function loadLocations() {
      try {
        const res = await fetch('/api/locations');
        const data = await res.json();
        locations = data.locations || [];
        renderLocations();
      } catch (e) {
        document.getElementById('locations').innerHTML = '<p style="color: red;">Failed to load locations</p>';
      }
    }

    function renderLocations() {
      const container = document.getElementById('locations');
      container.innerHTML = locations.map(loc => \`
        <label class="location \${selectedLocations.has(loc.id) ? 'selected' : ''}" data-id="\${loc.id}">
          <input type="checkbox" \${selectedLocations.has(loc.id) ? 'checked' : ''}>
          \${loc.name}
        </label>
      \`).join('');

      container.querySelectorAll('.location').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          const checkbox = el.querySelector('input');
          checkbox.checked = !checkbox.checked;
          toggleLocation(el.dataset.id, checkbox.checked);
        });
        el.querySelector('input').addEventListener('change', (e) => {
          toggleLocation(el.dataset.id, e.target.checked);
        });
      });

      updateButtons();
    }

    function toggleLocation(id, selected) {
      if (selected) {
        selectedLocations.add(id);
      } else {
        selectedLocations.delete(id);
      }
      document.querySelector(\`.location[data-id="\${id}"]\`).classList.toggle('selected', selected);
      updateButtons();
      updateSelectAll();
    }

    function updateButtons() {
      const hasSelection = selectedLocations.size > 0;
      document.getElementById('dryRunBtn').disabled = !hasSelection;
      document.getElementById('executeBtn').disabled = !hasSelection;
    }

    function updateSelectAll() {
      document.getElementById('selectAll').checked = selectedLocations.size === locations.length;
    }

    document.getElementById('selectAll').addEventListener('change', (e) => {
      locations.forEach(loc => {
        if (e.target.checked) {
          selectedLocations.add(loc.id);
        } else {
          selectedLocations.delete(loc.id);
        }
      });
      renderLocations();
    });

    async function runBootstrap(dryRun) {
      const loadingEl = document.getElementById('loadingAction');
      const loadingText = document.getElementById('loadingText');
      loadingEl.classList.add('active');
      loadingText.textContent = dryRun ? 'Analyzing...' : 'Adding BTB blocks...';

      document.getElementById('dryRunBtn').disabled = true;
      document.getElementById('executeBtn').disabled = true;

      try {
        const res = await fetch('/api/btb/bootstrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locationIds: Array.from(selectedLocations),
            dryRun,
          }),
        });

        const data = await res.json();
        displayResults(data, dryRun);
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        loadingEl.classList.remove('active');
        updateButtons();
      }
    }

    function displayResults(data, dryRun) {
      const card = document.getElementById('resultsCard');
      const summary = document.getElementById('summary');
      const results = document.getElementById('results');

      card.style.display = 'block';

      let totalAdded = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      data.results.forEach(r => {
        totalAdded += r.added.length;
        totalSkipped += r.skipped;
        totalErrors += r.errors.length;
      });

      summary.innerHTML = \`
        <strong>\${dryRun ? 'DRY RUN' : 'EXECUTED'}</strong> |
        Dates: \${data.dates} |
        <span class="added">\${dryRun ? 'Would add' : 'Added'}: \${totalAdded}</span> |
        <span class="skipped">Skipped (overlap): \${totalSkipped}</span>
        \${totalErrors > 0 ? \` | <span class="error">Errors: \${totalErrors}</span>\` : ''}
      \`;

      results.innerHTML = data.results.map(r => \`
        <div class="result-item">
          <h3>\${r.location}</h3>
          \${r.added.length > 0 ? \`
            <p class="added">\${dryRun ? 'Would add' : 'Added'}: \${r.added.length}</p>
            <ul class="result-list">\${r.added.map(a => \`<li>\${a}</li>\`).join('')}</ul>
          \` : '<p>No blocks to add</p>'}
          \${r.skipped > 0 ? \`<p class="skipped">Skipped (overlap): \${r.skipped}</p>\` : ''}
          \${r.errors.length > 0 ? \`
            <p class="error">Errors: \${r.errors.length}</p>
            <ul class="result-list">\${r.errors.map(e => \`<li class="error">\${e}</li>\`).join('')}</ul>
          \` : ''}
        </div>
      \`).join('');
    }

    document.getElementById('dryRunBtn').addEventListener('click', () => runBootstrap(true));
    document.getElementById('executeBtn').addEventListener('click', () => {
      if (confirm('This will add BTB blocks to Boulevard. Continue?')) {
        runBootstrap(false);
      }
    });

    loadLocations();
  </script>
</body>
</html>`;
  return c.html(html);
});

// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
console.log(`Boulevard Operations MCP Server starting on port ${PORT}`);
server.listen(PORT);

import "dotenv/config";
import { getShifts, getAppointments, getTimeblocks } from "../lib/boulevard";

const SUGAR_HOUSE_ID = "urn:blvd:Location:1d546022-4d3d-4f0f-9414-321e6251b595";

async function analyze() {
  // 4 weeks back from Mar 16, 2026
  const endDate = new Date("2026-03-16T23:59:59-07:00");
  const startDate = new Date("2026-02-17T00:00:00-07:00");

  console.log("Sugar House 4-Week Utilization Analysis");
  console.log("Period: Feb 17 - Mar 16, 2026");
  console.log("=========================================\n");

  // Get shifts
  const shifts = await getShifts(
    SUGAR_HOUSE_ID,
    startDate.toISOString().split("T")[0],
    endDate.toISOString().split("T")[0]
  );
  console.log(`Shifts in period: ${shifts.length}`);

  // Get all appointments - paginate through all
  let allAppts: any[] = [];
  const appts = await getAppointments(SUGAR_HOUSE_ID);
  allAppts = appts;

  // Filter to date range
  const periodAppts = allAppts.filter(a => {
    const d = new Date(a.startAt);
    return d >= startDate && d <= endDate && !a.cancelled;
  });
  console.log(`Appointments in period: ${periodAppts.length}`);

  // Get timeblocks
  const timeblocks = await getTimeblocks(SUGAR_HOUSE_ID);
  const periodBlocks = timeblocks.filter(tb => {
    const d = new Date(tb.startAt);
    return d >= startDate && d <= endDate;
  });
  console.log(`Timeblocks in period: ${periodBlocks.length}`);

  // Build utilization by staff + day + shift
  interface ShiftKey {
    staffId: string;
    staffName: string;
    dayOfWeek: number;
    clockIn: string;
    clockOut: string;
  }

  const shiftUtilization = new Map<string, {
    key: ShiftKey;
    instances: { date: string; shiftMin: number; bookedMin: number; blockedMin: number; util: number }[];
  }>();

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const shift of shifts) {
    const shiftStart = new Date(shift.startAt);
    const shiftEnd = new Date(shift.endAt);
    const shiftMin = (shiftEnd.getTime() - shiftStart.getTime()) / 60000;
    const dayOfWeek = shiftStart.getDay();
    const dateStr = shiftStart.toISOString().split("T")[0];

    const clockIn = shiftStart.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Denver"
    });
    const clockOut = shiftEnd.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Denver"
    });

    // Find appointments for this staff during this shift
    const shiftAppts = periodAppts.filter(a => {
      const aStart = new Date(a.startAt);
      const aEnd = new Date(a.endAt);
      const overlaps = aStart < shiftEnd && aEnd > shiftStart;
      const matchesStaff = a.appointmentServices?.some(
        (svc: any) => svc.staff?.id === shift.staffMember.id
      );
      return overlaps && matchesStaff;
    });

    let bookedMin = 0;
    for (const apt of shiftAppts) {
      const aStart = Math.max(new Date(apt.startAt).getTime(), shiftStart.getTime());
      const aEnd = Math.min(new Date(apt.endAt).getTime(), shiftEnd.getTime());
      bookedMin += (aEnd - aStart) / 60000;
    }

    // Find timeblocks for this staff during this shift
    const shiftBlocks = periodBlocks.filter(tb => {
      const tbStart = new Date(tb.startAt);
      const tbEnd = new Date(tb.endAt);
      const overlaps = tbStart < shiftEnd && tbEnd > shiftStart;
      const matchesStaff = tb.staffMember?.id === shift.staffMember.id;
      return overlaps && matchesStaff;
    });

    let blockedMin = 0;
    for (const tb of shiftBlocks) {
      const tbStart = Math.max(new Date(tb.startAt).getTime(), shiftStart.getTime());
      const tbEnd = Math.min(new Date(tb.endAt).getTime(), shiftEnd.getTime());
      blockedMin += (tbEnd - tbStart) / 60000;
    }

    // Cap blocked time at shift duration to prevent >100% utilization
    blockedMin = Math.min(blockedMin, shiftMin);

    const availableMin = shiftMin - blockedMin;
    const util = availableMin > 0 ? (bookedMin / availableMin) * 100 : 0;

    const key = `${shift.staffMember.id}|${dayOfWeek}|${clockIn}-${clockOut}`;

    if (!shiftUtilization.has(key)) {
      shiftUtilization.set(key, {
        key: {
          staffId: shift.staffMember.id,
          staffName: shift.staffMember.displayName || shift.staffMember.name,
          dayOfWeek,
          clockIn,
          clockOut
        },
        instances: []
      });
    }

    shiftUtilization.get(key)!.instances.push({
      date: dateStr,
      shiftMin,
      bookedMin,
      blockedMin,
      util
    });
  }

  // Calculate averages and find high utilization shifts
  const results: { name: string; day: string; shift: string; avgUtil: number; instances: number }[] = [];

  for (const [_, data] of shiftUtilization) {
    const avgUtil = data.instances.reduce((sum, i) => sum + i.util, 0) / data.instances.length;
    results.push({
      name: data.key.staffName,
      day: dayNames[data.key.dayOfWeek],
      shift: `${data.key.clockIn}-${data.key.clockOut}`,
      avgUtil: Math.round(avgUtil),
      instances: data.instances.length
    });
  }

  // Sort by utilization descending
  results.sort((a, b) => b.avgUtil - a.avgUtil);

  console.log("\n\n=== SHIFTS WITH ≥60% UTILIZATION (4-week avg) ===\n");
  const highUtil = results.filter(r => r.avgUtil >= 60);
  if (highUtil.length === 0) {
    console.log("No shifts with ≥60% utilization found.");
  } else {
    for (const r of highUtil) {
      console.log(`⚡️ ${r.name} - ${r.day} ${r.shift}: ${r.avgUtil}% (${r.instances} shifts)`);
    }
  }

  console.log("\n\n=== ALL SHIFTS BY UTILIZATION ===\n");
  for (const r of results.slice(0, 20)) {
    const marker = r.avgUtil >= 60 ? "⚡️" : "  ";
    console.log(`${marker} ${r.name.padEnd(20)} ${r.day.padEnd(4)} ${r.shift.padEnd(18)} ${r.avgUtil}%`);
  }

  // Summary by day
  console.log("\n\n=== LOCATION SUMMARY BY DAY ===\n");
  const byDay = new Map<number, { totalBooked: number; totalAvail: number }>();

  for (const [_, data] of shiftUtilization) {
    const day = data.key.dayOfWeek;
    if (!byDay.has(day)) byDay.set(day, { totalBooked: 0, totalAvail: 0 });
    for (const inst of data.instances) {
      byDay.get(day)!.totalBooked += inst.bookedMin;
      byDay.get(day)!.totalAvail += inst.shiftMin - inst.blockedMin;
    }
  }

  const daySummary = Array.from(byDay.entries())
    .map(([day, data]) => ({
      day: dayNames[day],
      util: data.totalAvail > 0 ? Math.round((data.totalBooked / data.totalAvail) * 100) : 0
    }))
    .sort((a, b) => b.util - a.util);

  for (const d of daySummary) {
    console.log(`${d.day}: ${d.util}%`);
  }
}

analyze().catch(console.error);

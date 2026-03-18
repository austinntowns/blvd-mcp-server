import "dotenv/config";
import { getLocations, getAppointmentsByCreatedDate, type Location, type Appointment } from "../lib/boulevard";

interface DailyCount {
  date: string;
  count: number;
}

interface LocationReport {
  location: Location;
  dailyCounts: DailyCount[];
  total: number;
}

function isNewClient(apt: Appointment, reportStartDate: string): boolean {
  // A "new client" is one whose client record was created within the reporting period
  // This means they just signed up and this is their first booking
  if (!apt.client?.createdAt) return false;
  const clientCreatedDate = apt.client.createdAt.split("T")[0];
  return clientCreatedDate >= reportStartDate;
}

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  let daysBack = 7;
  let stateFilter = "UT"; // Default to Utah
  let newClientsOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      daysBack = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--state" && args[i + 1]) {
      stateFilter = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === "--all-states") {
      stateFilter = "";
    } else if (args[i] === "--new-clients") {
      newClientsOnly = true;
    }
  }

  // Calculate date range
  const today = new Date();
  const endDate = today.toISOString().split("T")[0];
  const startDate = new Date(today.getTime() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  console.log("=".repeat(60));
  console.log(newClientsOnly ? "DAILY NEW CLIENT BOOKINGS REPORT" : "DAILY NEW BOOKINGS REPORT");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} to ${endDate} (${daysBack} days)`);
  console.log(`State Filter: ${stateFilter || "All states"}`);
  if (newClientsOnly) {
    console.log(`Filter: NEW CLIENTS ONLY (first-time bookings)`);
  }
  console.log("");

  // Get all locations
  console.log("Fetching locations...");
  const allLocations = await getLocations();

  // Filter by state
  const locations = stateFilter
    ? allLocations.filter(loc => loc.address?.state?.toUpperCase() === stateFilter)
    : allLocations;

  console.log(`Found ${locations.length} ${stateFilter || ""} locations\n`);

  if (locations.length === 0) {
    console.log("No locations found matching filter.");
    console.log("Available states:", [...new Set(allLocations.map(l => l.address?.state))].filter(Boolean).join(", "));
    return;
  }

  // Build date list for grouping
  const dates: string[] = [];
  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split("T")[0]);
  }

  const reports: LocationReport[] = [];
  const grandTotalByDate: Record<string, number> = {};
  dates.forEach(d => grandTotalByDate[d] = 0);

  // Process each location
  for (const location of locations) {
    console.log(`Processing ${location.name}...`);

    try {
      let appointments = await getAppointmentsByCreatedDate(
        location.id,
        startDate,
        endDate,
        2000
      );

      // Filter for new clients only if requested
      if (newClientsOnly) {
        appointments = appointments.filter(apt => isNewClient(apt, startDate));
      }

      // Group by creation date
      const countsByDate: Record<string, number> = {};
      dates.forEach(d => countsByDate[d] = 0);

      for (const apt of appointments) {
        if (apt.createdAt) {
          const createdDate = apt.createdAt.split("T")[0];
          if (countsByDate[createdDate] !== undefined) {
            countsByDate[createdDate]++;
            grandTotalByDate[createdDate]++;
          }
        }
      }

      const dailyCounts = dates.map(date => ({
        date,
        count: countsByDate[date],
      }));

      reports.push({
        location,
        dailyCounts,
        total: appointments.length,
      });
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      reports.push({
        location,
        dailyCounts: dates.map(d => ({ date: d, count: 0 })),
        total: 0,
      });
    }

    // Small delay between locations to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  // Print report
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS BY LOCATION");
  console.log("=".repeat(60));

  // Print header
  const colWidth = 6;
  const nameWidth = 25;
  const dayLabels = dates.map(d => {
    const date = new Date(d + "T12:00:00");
    return date.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 3);
  });

  console.log(
    "Location".padEnd(nameWidth) +
    dayLabels.map(d => d.padStart(colWidth)).join("") +
    " TOTAL".padStart(colWidth + 1)
  );
  console.log(
    "".padEnd(nameWidth) +
    dates.map(d => d.slice(5).padStart(colWidth)).join("") +
    "".padStart(colWidth + 1)
  );
  console.log("-".repeat(nameWidth + dates.length * colWidth + colWidth + 1));

  // Print each location's data
  for (const report of reports.sort((a, b) => b.total - a.total)) {
    const name = report.location.name.slice(0, nameWidth - 1).padEnd(nameWidth);
    const counts = report.dailyCounts.map(dc =>
      dc.count.toString().padStart(colWidth)
    ).join("");
    const total = report.total.toString().padStart(colWidth + 1);

    console.log(name + counts + total);
  }

  // Print totals row
  console.log("-".repeat(nameWidth + dates.length * colWidth + colWidth + 1));
  const totalRow = dates.map(d =>
    grandTotalByDate[d].toString().padStart(colWidth)
  ).join("");
  const grandTotal = Object.values(grandTotalByDate).reduce((a, b) => a + b, 0);
  console.log(
    "TOTAL".padEnd(nameWidth) +
    totalRow +
    grandTotal.toString().padStart(colWidth + 1)
  );

  // Summary stats
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total ${newClientsOnly ? "new client " : ""}bookings: ${grandTotal}`);
  console.log(`Daily average: ${(grandTotal / daysBack).toFixed(1)}`);
  console.log(`Locations: ${locations.length}`);

  // Best and worst days
  const sortedDays = Object.entries(grandTotalByDate).sort((a, b) => b[1] - a[1]);
  console.log(`Best day: ${sortedDays[0][0]} (${sortedDays[0][1]} bookings)`);
  console.log(`Slowest day: ${sortedDays[sortedDays.length - 1][0]} (${sortedDays[sortedDays.length - 1][1]} bookings)`);
}

main().catch(console.error);

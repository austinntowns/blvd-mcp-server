import * as fs from "fs";

interface QuarterlyCount {
  "2025-Q1": number;
  "2025-Q2": number;
  "2025-Q3": number;
  "2025-Q4": number;
  "2026-Q1": number;
  total: number;
}

interface ServiceData {
  id: string;
  name: string;
  category: string;
  quarters: QuarterlyCount;
}

interface EnrichedService extends ServiceData {
  avgPerQuarter: number;
  trend: string;
  trendScore: number;
  recentMomentum: string;
  lastActiveQuarter: string;
  daysSinceActivity: number;
  pctOfTotal: number;
  recommendation: string;
  priority: number;
}

// Read the JSON data
const data = JSON.parse(fs.readFileSync("exports/service-usage-by-quarter.json", "utf8"));
const services: ServiceData[] = data.services;
const grandTotal = services.reduce((sum, s) => sum + s.quarters.total, 0);

// Quarter order for analysis
const quarters = ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1"] as const;

// Days since each quarter ended (approximate from 2026-03-22)
const daysSinceQuarterEnd: Record<string, number> = {
  "2025-Q1": 365, // ~1 year ago
  "2025-Q2": 270, // ~9 months ago
  "2025-Q3": 180, // ~6 months ago
  "2025-Q4": 82,  // ~3 months ago
  "2026-Q1": 0,   // Current quarter
};

function calculateTrend(q: QuarterlyCount): { trend: string; score: number } {
  const values = [q["2025-Q1"], q["2025-Q2"], q["2025-Q3"], q["2025-Q4"], q["2026-Q1"]];

  // Simple linear regression slope
  const n = values.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = values.reduce((sum, y, x) => sum + x * y, 0);
  const sumX2 = values.reduce((sum, _, x) => sum + x * x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgY = sumY / n;

  // Normalize slope relative to average
  const normalizedSlope = avgY > 0 ? slope / avgY : 0;

  if (normalizedSlope > 0.15) return { trend: "Growing", score: normalizedSlope };
  if (normalizedSlope < -0.15) return { trend: "Declining", score: normalizedSlope };
  return { trend: "Stable", score: normalizedSlope };
}

function getLastActiveQuarter(q: QuarterlyCount): string {
  for (let i = quarters.length - 1; i >= 0; i--) {
    if (q[quarters[i]] > 0) return quarters[i];
  }
  return "Never";
}

function getRecentMomentum(q: QuarterlyCount): string {
  const q4 = q["2025-Q4"];
  const q1_26 = q["2026-Q1"];

  if (q4 === 0 && q1_26 === 0) return "Dead";
  if (q4 === 0 && q1_26 > 0) return "Revived";
  if (q1_26 === 0) return "Stopped";

  const change = (q1_26 - q4) / Math.max(q4, 1);
  if (change > 0.2) return "Accelerating";
  if (change < -0.2) return "Slowing";
  return "Steady";
}

function getRecommendation(s: EnrichedService): { rec: string; priority: number } {
  const q = s.quarters;

  // No activity in last 2 quarters
  if (q["2025-Q4"] === 0 && q["2026-Q1"] === 0) {
    return { rec: "DEPRECATE", priority: 1 };
  }

  // Very low volume overall (<10 total) and declining
  if (s.quarters.total < 10 && s.trendScore < 0) {
    return { rec: "DEPRECATE", priority: 2 };
  }

  // Low volume (<50) and declining
  if (s.quarters.total < 50 && s.trendScore < -0.1) {
    return { rec: "REVIEW", priority: 3 };
  }

  // Low volume but stable or growing - might be new
  if (s.quarters.total < 50 && s.trendScore >= 0) {
    return { rec: "MONITOR", priority: 4 };
  }

  // Medium volume (50-200) and declining significantly
  if (s.quarters.total < 200 && s.trendScore < -0.2) {
    return { rec: "REVIEW", priority: 4 };
  }

  // Everything else
  return { rec: "KEEP", priority: 5 };
}

// Enrich each service
const enriched: EnrichedService[] = services.map(s => {
  const q = s.quarters;
  const { trend, score } = calculateTrend(q);
  const lastActive = getLastActiveQuarter(q);

  const enrichedService: EnrichedService = {
    ...s,
    avgPerQuarter: Math.round((q.total / 5) * 10) / 10,
    trend,
    trendScore: Math.round(score * 100) / 100,
    recentMomentum: getRecentMomentum(q),
    lastActiveQuarter: lastActive,
    daysSinceActivity: lastActive === "Never" ? 999 : daysSinceQuarterEnd[lastActive],
    pctOfTotal: Math.round((q.total / grandTotal) * 10000) / 100,
    recommendation: "",
    priority: 0,
  };

  const { rec, priority } = getRecommendation(enrichedService);
  enrichedService.recommendation = rec;
  enrichedService.priority = priority;

  return enrichedService;
});

// Sort by priority (deprecate first), then by total uses
enriched.sort((a, b) => {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.quarters.total - b.quarters.total;
});

// Generate CSV
const csvHeaders = [
  "Service Name",
  "Category",
  "2025-Q1",
  "2025-Q2",
  "2025-Q3",
  "2025-Q4",
  "2026-Q1",
  "Total",
  "Avg/Qtr",
  "% of Total",
  "Trend",
  "Trend Score",
  "Recent Momentum",
  "Last Active",
  "Days Inactive",
  "Recommendation",
];

const csvRows = enriched.map(s => [
  `"${s.name.replace(/"/g, '""')}"`,
  `"${s.category}"`,
  s.quarters["2025-Q1"],
  s.quarters["2025-Q2"],
  s.quarters["2025-Q3"],
  s.quarters["2025-Q4"],
  s.quarters["2026-Q1"],
  s.quarters.total,
  s.avgPerQuarter,
  s.pctOfTotal,
  s.trend,
  s.trendScore,
  s.recentMomentum,
  s.lastActiveQuarter,
  s.daysSinceActivity,
  s.recommendation,
].join(","));

const csvContent = [csvHeaders.join(","), ...csvRows].join("\n");
fs.writeFileSync("exports/service-usage-enriched.csv", csvContent);

// Summary stats
const deprecateCount = enriched.filter(s => s.recommendation === "DEPRECATE").length;
const reviewCount = enriched.filter(s => s.recommendation === "REVIEW").length;
const monitorCount = enriched.filter(s => s.recommendation === "MONITOR").length;
const keepCount = enriched.filter(s => s.recommendation === "KEEP").length;

console.log("=".repeat(60));
console.log("ENRICHED SERVICE DATA - SUMMARY");
console.log("=".repeat(60));
console.log(`\nTotal services: ${enriched.length}`);
console.log(`\nRecommendations:`);
console.log(`  DEPRECATE: ${deprecateCount} services (safe to remove)`);
console.log(`  REVIEW:    ${reviewCount} services (low volume, declining)`);
console.log(`  MONITOR:   ${monitorCount} services (low volume but stable/growing)`);
console.log(`  KEEP:      ${keepCount} services (healthy usage)`);

console.log("\n" + "=".repeat(60));
console.log("TOP DEPRECATION CANDIDATES");
console.log("=".repeat(60));
const toDeprecate = enriched.filter(s => s.recommendation === "DEPRECATE").slice(0, 30);
console.log("\nService Name".padEnd(55) + "| Total | Last Active | Category");
console.log("-".repeat(100));
for (const s of toDeprecate) {
  const name = s.name.slice(0, 53).padEnd(55);
  const total = s.quarters.total.toString().padStart(5);
  const last = s.lastActiveQuarter.padEnd(11);
  console.log(`${name}|${total} | ${last} | ${s.category}`);
}

console.log("\n" + "=".repeat(60));
console.log("SERVICES TO REVIEW (declining, low volume)");
console.log("=".repeat(60));
const toReview = enriched.filter(s => s.recommendation === "REVIEW").slice(0, 20);
console.log("\nService Name".padEnd(55) + "| Total | Trend     | Momentum");
console.log("-".repeat(100));
for (const s of toReview) {
  const name = s.name.slice(0, 53).padEnd(55);
  const total = s.quarters.total.toString().padStart(5);
  const trend = s.trend.padEnd(9);
  console.log(`${name}|${total} | ${trend} | ${s.recentMomentum}`);
}

console.log(`\nEnriched data exported to: exports/service-usage-enriched.csv`);

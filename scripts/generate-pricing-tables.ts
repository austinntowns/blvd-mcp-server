/**
 * Generate comprehensive pricing and timing tables
 */

import { readFileSync, writeFileSync } from "fs";

const data = JSON.parse(readFileSync("exports/hello-sugar-pricing.json", "utf-8"));

function centsToDollars(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function intervalToText(interval: string): string {
  if (interval === "P1M") return "Monthly";
  if (interval === "P2M") return "Every 8 Weeks";
  if (interval === "P3M") return "Quarterly";
  if (interval === "P1Y") return "Yearly";
  return interval;
}

let md = `# Hello Sugar Complete Pricing & Service Timing

> **Extracted**: ${new Date(data.fetchedAt).toLocaleString()}
> **Source**: Boulevard Admin API

---

## Table of Contents

1. [All Membership Plans (${data.membershipPlans.length})](#1-all-membership-plans)
2. [All Services with Pricing & Duration (${data.services.length})](#2-all-services-with-pricing--duration)
3. [Services by Category](#3-services-by-category)

---

## 1. All Membership Plans

**Total Plans**: ${data.membershipPlans.length}

| Membership Name | Price | Interval | Description |
|-----------------|-------|----------|-------------|
`;

// Sort memberships by price descending
const sortedPlans = [...data.membershipPlans]
  .filter((p: any) => p.active !== false)
  .sort((a: any, b: any) => (b.unitPrice || 0) - (a.unitPrice || 0));

for (const plan of sortedPlans) {
  const desc = plan.description
    ? plan.description.substring(0, 80).replace(/\n/g, ' ') + (plan.description.length > 80 ? '...' : '')
    : '-';
  md += `| ${plan.name} | ${centsToDollars(plan.unitPrice)} | ${intervalToText(plan.interval)} | ${desc} |\n`;
}

md += `
---

## 2. All Services with Pricing & Duration

**Total Services**: ${data.services.length}
**Active Services**: ${data.services.filter((s: any) => s.active !== false).length}

| Service Name | Price | Duration | Category | Active |
|--------------|-------|----------|----------|--------|
`;

// Sort services by category then by price
const sortedServices = [...data.services]
  .sort((a: any, b: any) => {
    const catA = a.category?.name || 'ZZZ';
    const catB = b.category?.name || 'ZZZ';
    if (catA !== catB) return catA.localeCompare(catB);
    return (b.defaultPrice || 0) - (a.defaultPrice || 0);
  });

for (const svc of sortedServices) {
  const duration = svc.defaultDuration ? `${svc.defaultDuration} min` : '-';
  const category = svc.category?.name || 'Uncategorized';
  const active = svc.active !== false ? 'Yes' : 'No';
  md += `| ${svc.name} | ${centsToDollars(svc.defaultPrice)} | ${duration} | ${category} | ${active} |\n`;
}

md += `
---

## 3. Services by Category

`;

// Group by category
const byCategory: Record<string, any[]> = {};
for (const svc of data.services) {
  const cat = svc.category?.name || 'Uncategorized';
  if (!byCategory[cat]) byCategory[cat] = [];
  byCategory[cat].push(svc);
}

// Sort categories by service count
const sortedCategories = Object.entries(byCategory)
  .sort((a, b) => b[1].length - a[1].length);

for (const [category, services] of sortedCategories) {
  const activeServices = services.filter((s: any) => s.active !== false);
  const prices = activeServices.map((s: any) => s.defaultPrice || 0).filter((p: number) => p > 0);
  const durations = activeServices.map((s: any) => s.defaultDuration || 0).filter((d: number) => d > 0);

  const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

  md += `### ${category} (${services.length} services, ${activeServices.length} active)

| Metric | Value |
|--------|-------|
| Price Range | ${centsToDollars(minPrice)} - ${centsToDollars(maxPrice)} |
| Avg Price | ${centsToDollars(avgPrice)} |
| Avg Duration | ${avgDuration.toFixed(0)} min |

<details>
<summary>View all ${category} services</summary>

| Service | Price | Duration |
|---------|-------|----------|
${activeServices
  .sort((a: any, b: any) => (b.defaultPrice || 0) - (a.defaultPrice || 0))
  .map((s: any) => `| ${s.name} | ${centsToDollars(s.defaultPrice)} | ${s.defaultDuration || '-'} min |`)
  .join('\n')}

</details>

`;
}

md += `---

*Generated: ${new Date().toISOString()}*
`;

writeFileSync("HelloSugar-Pricing-Complete.md", md);
console.log("✅ Generated HelloSugar-Pricing-Complete.md");
console.log(`   - ${sortedPlans.length} membership plans`);
console.log(`   - ${sortedServices.length} services`);
console.log(`   - ${sortedCategories.length} categories`);

// Also output a quick summary
console.log("\n📊 QUICK SUMMARY\n");

console.log("TOP 10 MEMBERSHIPS BY PRICE:");
sortedPlans.slice(0, 10).forEach((p: any, i: number) => {
  console.log(`  ${i + 1}. ${p.name}: ${centsToDollars(p.unitPrice)}/${intervalToText(p.interval)}`);
});

console.log("\nTOP 10 SERVICES BY PRICE:");
const byPrice = [...data.services]
  .filter((s: any) => s.active !== false && s.defaultPrice > 0)
  .sort((a: any, b: any) => b.defaultPrice - a.defaultPrice);
byPrice.slice(0, 10).forEach((s: any, i: number) => {
  console.log(`  ${i + 1}. ${s.name}: ${centsToDollars(s.defaultPrice)} (${s.defaultDuration} min)`);
});

console.log("\nLONGEST SERVICES:");
const byDuration = [...data.services]
  .filter((s: any) => s.active !== false && s.defaultDuration > 0)
  .sort((a: any, b: any) => b.defaultDuration - a.defaultDuration);
byDuration.slice(0, 10).forEach((s: any, i: number) => {
  console.log(`  ${i + 1}. ${s.name}: ${s.defaultDuration} min (${centsToDollars(s.defaultPrice)})`);
});

/**
 * Analyze Hello Sugar data and generate comprehensive HelloSugar.md
 */

import { readFileSync, writeFileSync } from "fs";

interface BusinessData {
  extractedAt: string;
  locations: any[];
  services: any[];
  serviceCategories: any[];
  staff: any[];
  clients: { total: number; sample: any[] };
  memberships: any[];
  products: any[];
  appointmentStats: any;
}

const data: BusinessData = JSON.parse(
  readFileSync("exports/hello-sugar-raw-data.json", "utf-8")
);

// ========== ANALYSIS FUNCTIONS ==========

function analyzeLocations() {
  const byState: Record<string, any[]> = {};
  const byCity: Record<string, any[]> = {};

  for (const loc of data.locations) {
    const state = loc.address?.state || "Unknown";
    const city = loc.address?.city || "Unknown";

    if (!byState[state]) byState[state] = [];
    byState[state].push(loc);

    const cityKey = `${city}, ${state}`;
    if (!byCity[cityKey]) byCity[cityKey] = [];
    byCity[cityKey].push(loc);
  }

  // Sort states by location count
  const statesSorted = Object.entries(byState)
    .sort((a, b) => b[1].length - a[1].length);

  // Cities with multiple locations
  const multiLocationCities = Object.entries(byCity)
    .filter(([_, locs]) => locs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  return { byState, byCity, statesSorted, multiLocationCities };
}

function analyzeServices() {
  const byCategory: Record<string, any[]> = {};
  const categoryNames: Record<string, string> = {};

  for (const svc of data.services) {
    const catId = svc.category?.id || "uncategorized";
    const catName = svc.category?.name || "Uncategorized";
    categoryNames[catId] = catName;

    if (!byCategory[catId]) byCategory[catId] = [];
    byCategory[catId].push(svc);
  }

  // Group by category name for better organization
  const byCategoryName: Record<string, any[]> = {};
  for (const [catId, services] of Object.entries(byCategory)) {
    const name = categoryNames[catId];
    if (!byCategoryName[name]) byCategoryName[name] = [];
    byCategoryName[name].push(...services);
  }

  // Sort by service count
  const categoriesSorted = Object.entries(byCategoryName)
    .sort((a, b) => b[1].length - a[1].length);

  return { byCategory: byCategoryName, categoriesSorted };
}

function analyzeStaff() {
  const byRole: Record<string, any[]> = {};
  const byLocation: Record<string, any[]> = {};

  for (const s of data.staff) {
    const role = s.role?.name || "No Role";
    if (!byRole[role]) byRole[role] = [];
    byRole[role].push(s);

    for (const loc of s.locations || []) {
      const locName = loc.name || loc.id;
      if (!byLocation[locName]) byLocation[locName] = [];
      byLocation[locName].push(s);
    }
  }

  const rolesSorted = Object.entries(byRole)
    .sort((a, b) => b[1].length - a[1].length);

  return { byRole, byLocation, rolesSorted };
}

function analyzeMemberships() {
  const byInterval: Record<string, any[]> = {};
  const uniqueNames = new Set<string>();
  const membershipTypes: Record<string, { count: number; services: Set<string> }> = {};

  for (const m of data.memberships) {
    const interval = m.interval || "Unknown";
    if (!byInterval[interval]) byInterval[interval] = [];
    byInterval[interval].push(m);

    uniqueNames.add(m.name);

    // Track membership types and their services
    if (!membershipTypes[m.name]) {
      membershipTypes[m.name] = { count: 0, services: new Set() };
    }
    membershipTypes[m.name].count++;

    for (const voucher of m.vouchers || []) {
      for (const svc of voucher.services || []) {
        membershipTypes[m.name].services.add(svc.name);
      }
    }
  }

  // Most popular membership types (by active subscribers)
  const typesSorted = Object.entries(membershipTypes)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30);

  return { byInterval, uniqueNames: [...uniqueNames], typesSorted };
}

function analyzeClients() {
  const clients = data.clients.sample;

  // Appointment counts
  const appointmentCounts = clients.map(c => c.appointmentCount || 0);
  const totalAppointments = appointmentCounts.reduce((a, b) => a + b, 0);
  const avgAppointments = totalAppointments / clients.length;
  const maxAppointments = Math.max(...appointmentCounts);

  // Distribution of appointment counts
  const distribution = {
    "1 visit": 0,
    "2-5 visits": 0,
    "6-10 visits": 0,
    "11-20 visits": 0,
    "21-50 visits": 0,
    "51+ visits": 0,
  };

  for (const count of appointmentCounts) {
    if (count === 1) distribution["1 visit"]++;
    else if (count <= 5) distribution["2-5 visits"]++;
    else if (count <= 10) distribution["6-10 visits"]++;
    else if (count <= 20) distribution["11-20 visits"]++;
    else if (count <= 50) distribution["21-50 visits"]++;
    else distribution["51+ visits"]++;
  }

  // Tags analysis
  const tagCounts: Record<string, number> = {};
  for (const c of clients) {
    for (const tag of c.tags || []) {
      tagCounts[tag.name] = (tagCounts[tag.name] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  return {
    totalSampled: clients.length,
    avgAppointments,
    maxAppointments,
    distribution,
    topTags
  };
}

function analyzeProducts() {
  // Simple product analysis
  const products = data.products;
  const withBarcode = products.filter(p => p.barcode).length;
  const withDescription = products.filter(p => p.description).length;

  return {
    total: products.length,
    withBarcode,
    withDescription,
    sample: products.slice(0, 20)
  };
}

// ========== GENERATE MARKDOWN ==========

function generateMarkdown(): string {
  const locAnalysis = analyzeLocations();
  const svcAnalysis = analyzeServices();
  const staffAnalysis = analyzeStaff();
  const membershipAnalysis = analyzeMemberships();
  const clientAnalysis = analyzeClients();
  const productAnalysis = analyzeProducts();

  let md = `# Hello Sugar Business Profile

> **Extracted from Boulevard**: ${new Date(data.extractedAt).toLocaleString()}
>
> This document provides a comprehensive overview of Hello Sugar's business operations, services, memberships, and organizational structure based on data from the Boulevard booking platform.

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total Locations | **${data.locations.length}** |
| States Operating In | **${locAnalysis.statesSorted.length}** |
| Total Services Offered | **${data.services.length}** |
| Service Categories | **${svcAnalysis.categoriesSorted.length}** |
| Total Staff Members | **${data.staff.length}** |
| Active Memberships | **${data.memberships.length}** |
| Unique Membership Types | **${membershipAnalysis.uniqueNames.length}** |
| Retail Products | **${data.products.length}** |

---

## 1. Geographic Footprint

Hello Sugar operates **${data.locations.length} locations** across **${locAnalysis.statesSorted.length} states**, making it one of the largest waxing salon chains in the United States.

### States by Location Count

| State | Locations | % of Total |
|-------|-----------|------------|
${locAnalysis.statesSorted.map(([state, locs]) =>
  `| ${state} | ${locs.length} | ${((locs.length / data.locations.length) * 100).toFixed(1)}% |`
).join('\n')}

### Top Markets (Cities with 2+ Locations)

${locAnalysis.multiLocationCities.length > 0
  ? locAnalysis.multiLocationCities.map(([city, locs]) =>
      `- **${city}**: ${locs.length} locations`
    ).join('\n')
  : 'All cities currently have single locations.'}

### Full Location List

<details>
<summary>Click to expand all ${data.locations.length} locations</summary>

${locAnalysis.statesSorted.map(([state, locs]) => `
#### ${state} (${locs.length} locations)
${locs.map((loc: any) =>
  `- **${loc.name}**
  - Address: ${loc.address?.line1 || 'N/A'}, ${loc.address?.city || ''}, ${loc.address?.state || ''} ${loc.address?.zip || ''}`
).join('\n')}
`).join('\n')}

</details>

---

## 2. Services

Hello Sugar offers **${data.services.length} services** across **${svcAnalysis.categoriesSorted.length} categories**. The business specializes in waxing services with additional offerings in skincare, facials, and related beauty treatments.

### Service Categories Overview

| Category | Services | % of Total |
|----------|----------|------------|
${svcAnalysis.categoriesSorted.slice(0, 30).map(([cat, services]) =>
  `| ${cat} | ${services.length} | ${((services.length / data.services.length) * 100).toFixed(1)}% |`
).join('\n')}

### Services by Category (Detailed)

${svcAnalysis.categoriesSorted.map(([category, services]) => `
#### ${category} (${services.length} services)

${services.map((s: any) => `- ${s.name}${s.description ? ` - *${s.description.substring(0, 100)}${s.description.length > 100 ? '...' : ''}*` : ''}`).join('\n')}
`).join('\n')}

---

## 3. Memberships

Hello Sugar has **${data.memberships.length} active membership subscriptions** across **${membershipAnalysis.uniqueNames.length} unique membership types**.

### Membership Intervals

| Billing Interval | Count | % of Total |
|-----------------|-------|------------|
${Object.entries(membershipAnalysis.byInterval).sort((a, b) => b[1].length - a[1].length).map(([interval, members]) =>
  `| ${interval} | ${(members as any[]).length} | ${(((members as any[]).length / data.memberships.length) * 100).toFixed(1)}% |`
).join('\n')}

### Top Membership Types (by Active Subscribers)

| Membership Name | Active Subscribers | Included Services |
|-----------------|-------------------|-------------------|
${membershipAnalysis.typesSorted.map(([name, info]) =>
  `| ${name} | ${info.count} | ${[...info.services].slice(0, 3).join(', ')}${info.services.size > 3 ? ` (+${info.services.size - 3} more)` : ''} |`
).join('\n')}

### All Unique Membership Types

<details>
<summary>Click to expand all ${membershipAnalysis.uniqueNames.length} membership types</summary>

${membershipAnalysis.uniqueNames.sort().map(name => `- ${name}`).join('\n')}

</details>

---

## 4. Staff & Team

Hello Sugar employs **${data.staff.length} team members** across all locations.

### Staff by Role

| Role | Count | % of Total |
|------|-------|------------|
${staffAnalysis.rolesSorted.map(([role, staff]) =>
  `| ${role} | ${staff.length} | ${((staff.length / data.staff.length) * 100).toFixed(1)}% |`
).join('\n')}

### Average Staff per Location

**${(data.staff.length / data.locations.length).toFixed(1)} staff members** per location on average.

---

## 5. Client Base

Based on a sample of **${clientAnalysis.totalSampled} clients**:

### Client Engagement Metrics

| Metric | Value |
|--------|-------|
| Average Appointments per Client | **${clientAnalysis.avgAppointments.toFixed(1)}** |
| Maximum Appointments (Most Loyal Client) | **${clientAnalysis.maxAppointments}** |

### Visit Frequency Distribution

| Visit Count | Clients | % |
|-------------|---------|---|
${Object.entries(clientAnalysis.distribution).map(([range, count]) =>
  `| ${range} | ${count} | ${((count / clientAnalysis.totalSampled) * 100).toFixed(1)}% |`
).join('\n')}

### Client Tags (Top 20)

Client tagging is used for segmentation and marketing:

| Tag | Count |
|-----|-------|
${clientAnalysis.topTags.map(([tag, count]) => `| ${tag} | ${count} |`).join('\n')}

---

## 6. Products

Hello Sugar offers **${productAnalysis.total} retail products** for sale.

| Metric | Value |
|--------|-------|
| Total Products | ${productAnalysis.total} |
| Products with Barcode | ${productAnalysis.withBarcode} |
| Products with Description | ${productAnalysis.withDescription} |

### Sample Products

${productAnalysis.sample.map((p: any) => `- **${p.name}**${p.description ? `: ${p.description.substring(0, 80)}...` : ''}`).join('\n')}

---

## 7. Business Model Insights

### Key Observations

1. **National Scale**: With ${data.locations.length} locations across ${locAnalysis.statesSorted.length} states, Hello Sugar has achieved significant national presence in the waxing/beauty services industry.

2. **Texas Dominance**: ${locAnalysis.statesSorted.find(([s]) => s === 'TX')?.[1].length || 0} locations in Texas represent the largest state concentration, suggesting the brand's origin or strongest market.

3. **Membership-Driven Revenue**: ${data.memberships.length.toLocaleString()} active memberships indicate a strong recurring revenue model. The average of ${(data.memberships.length / data.locations.length).toFixed(0)} memberships per location suggests healthy subscription penetration.

4. **Service Specialization**: The service catalog of ${data.services.length} services across ${svcAnalysis.categoriesSorted.length} categories shows a focused but comprehensive approach to beauty services.

5. **Team Scale**: With ${data.staff.length} staff members (~${(data.staff.length / data.locations.length).toFixed(0)} per location), the company maintains consistent service capacity.

6. **Client Loyalty**: The appointment distribution shows ${((clientAnalysis.distribution["6-10 visits"] + clientAnalysis.distribution["11-20 visits"] + clientAnalysis.distribution["21-50 visits"] + clientAnalysis.distribution["51+ visits"]) / clientAnalysis.totalSampled * 100).toFixed(0)}% of sampled clients are repeat visitors (6+ visits), indicating strong retention.

### Growth Indicators

- **Geographic Expansion**: Presence in ${locAnalysis.statesSorted.length} states shows aggressive expansion strategy
- **Service Evolution**: ${data.services.length} services allow for upselling and cross-selling
- **Membership Variety**: ${membershipAnalysis.uniqueNames.length} membership types cater to different customer segments
- **Product Retail**: ${productAnalysis.total} retail products provide additional revenue streams

---

## Appendix: Data Quality Notes

- **Data Source**: Boulevard Admin API
- **Extraction Date**: ${new Date(data.extractedAt).toISOString()}
- **Client Sample Size**: ${clientAnalysis.totalSampled} (not total client base)
- **Membership Count**: Reflects active memberships, not total historical
- **Staff Count**: Includes all roles (service providers, managers, etc.)

---

*This document was automatically generated for business intelligence and model training purposes.*
`;

  return md;
}

// ========== MAIN ==========

const markdown = generateMarkdown();
writeFileSync("HelloSugar.md", markdown);
console.log("✅ Generated HelloSugar.md");
console.log(`   - ${data.locations.length} locations analyzed`);
console.log(`   - ${data.services.length} services documented`);
console.log(`   - ${data.memberships.length} memberships analyzed`);
console.log(`   - ${data.staff.length} staff members counted`);

/**
 * Generate comprehensive HelloSugar.md with ALL data
 */

import { readFileSync, writeFileSync } from "fs";

const data = JSON.parse(readFileSync("exports/hello-sugar-raw-data.json", "utf-8"));
const pricingData = JSON.parse(readFileSync("exports/hello-sugar-pricing.json", "utf-8"));

function centsToDollars(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

function intervalToText(interval: string): string {
  if (interval === "P1M") return "Monthly";
  if (interval === "P2M") return "Every 8 Weeks";
  if (interval === "P3M") return "Quarterly";
  return interval;
}

function escapeMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

// ========== ANALYSIS FUNCTIONS ==========

function analyzeLocations() {
  const byState: Record<string, any[]> = {};
  for (const loc of data.locations) {
    const state = loc.address?.state || "Unknown";
    if (!byState[state]) byState[state] = [];
    byState[state].push(loc);
  }
  return Object.entries(byState).sort((a, b) => b[1].length - a[1].length);
}

function analyzeStaff() {
  const byRole: Record<string, any[]> = {};
  for (const s of data.staff) {
    const role = s.role?.name || "No Role";
    if (!byRole[role]) byRole[role] = [];
    byRole[role].push(s);
  }
  return Object.entries(byRole).sort((a, b) => b[1].length - a[1].length);
}

function analyzeMemberships() {
  const byInterval: Record<string, any[]> = {};
  const types: Record<string, { count: number; services: Set<string> }> = {};

  for (const m of data.memberships) {
    const interval = m.interval || "Unknown";
    if (!byInterval[interval]) byInterval[interval] = [];
    byInterval[interval].push(m);

    if (!types[m.name]) types[m.name] = { count: 0, services: new Set() };
    types[m.name].count++;
    for (const v of m.vouchers || []) {
      for (const s of v.services || []) types[m.name].services.add(s.name);
    }
  }

  return {
    byInterval,
    topTypes: Object.entries(types).sort((a, b) => b[1].count - a[1].count).slice(0, 30)
  };
}

// ========== GENERATE MARKDOWN ==========

let md = `# Hello Sugar - Complete Business Intelligence Document

> **Purpose**: Comprehensive business data for model training and analysis
> **Source**: Boulevard Admin API
> **Extracted**: ${new Date(data.extractedAt).toLocaleDateString()}
> **Last Updated**: ${new Date().toISOString()}

This document contains complete operational data for Hello Sugar, a national waxing and beauty services franchise.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [All Locations (${data.locations.length})](#2-all-locations)
3. [All Services with Descriptions (${data.servicesWithDescriptions?.length || data.services.length})](#3-all-services-with-descriptions)
4. [All Membership Plans (${pricingData.membershipPlans.length})](#4-all-membership-plans)
5. [All Products with Descriptions (${data.productsWithDescriptions?.length || data.products.length})](#5-all-products-with-descriptions)
6. [Staff & Organization (${data.staff.length})](#6-staff--organization)
7. [Active Memberships Analysis (${data.memberships.length})](#7-active-memberships-analysis)
8. [Client Behavior & Retention](#8-client-behavior--retention)
9. [Service Popularity](#9-service-popularity)
10. [Business Model Insights](#10-business-model-insights)

---

## 1. Executive Summary

| Metric | Value |
|--------|-------|
| **Total Locations** | ${data.locations.length} |
| **States** | ${analyzeLocations().length} |
| **Total Services** | ${data.servicesWithDescriptions?.length || data.services.length} |
| **Services with Descriptions** | ${(data.servicesWithDescriptions || []).filter((s: any) => s.description).length} |
| **Membership Plans** | ${pricingData.membershipPlans.length} |
| **Active Memberships** | ${data.memberships.length.toLocaleString()}+ |
| **Total Staff** | ${data.staff.length.toLocaleString()} |
| **Total Products** | ${data.productsWithDescriptions?.length || data.products.length} |
| **Products with Descriptions** | ${(data.productsWithDescriptions || []).filter((p: any) => p.description).length} |
| **Repeat Client Rate** | ${data.clientStats?.retentionRate || 'N/A'}% |

### Business Overview

Hello Sugar is a **membership-driven waxing and beauty services franchise** operating ${data.locations.length} locations across ${analyzeLocations().length} U.S. states. The business model centers on recurring monthly subscriptions for waxing services, with expansion into laser hair removal, facials, and spray tanning.

**Core Services**: Brazilian wax (flagship), brow services, body waxing, laser hair removal
**Revenue Model**: Subscription memberships (primary), a la carte services, retail products
**Target Market**: Young professionals, college students, recurring groomers

---

## 2. All Locations

**Total**: ${data.locations.length} locations across ${analyzeLocations().length} states

`;

// Locations by state
const statesSorted = analyzeLocations();
for (const [state, locs] of statesSorted) {
  md += `### ${state} (${locs.length} location${locs.length > 1 ? 's' : ''})\n\n`;
  md += `| Location Name | Address | City | ZIP |\n`;
  md += `|---------------|---------|------|-----|\n`;
  for (const loc of locs) {
    const addr = escapeMarkdown(loc.address?.line1) || 'N/A';
    const city = loc.address?.city || '';
    const zip = loc.address?.zip || '';
    md += `| ${escapeMarkdown(loc.name)} | ${addr} | ${city} | ${zip} |\n`;
  }
  md += `\n`;
}

md += `---

## 3. All Services with Descriptions

**Total Services**: ${data.servicesWithDescriptions?.length || data.services.length}
**With Descriptions**: ${(data.servicesWithDescriptions || []).filter((s: any) => s.description).length}

`;

// Group services by category
const servicesByCategory: Record<string, any[]> = {};
const services = data.servicesWithDescriptions || data.services;
for (const svc of services) {
  const cat = svc.category?.name || "Uncategorized";
  if (!servicesByCategory[cat]) servicesByCategory[cat] = [];
  servicesByCategory[cat].push(svc);
}

const sortedCategories = Object.entries(servicesByCategory)
  .sort((a, b) => b[1].length - a[1].length);

for (const [category, svcs] of sortedCategories) {
  const activeCount = svcs.filter((s: any) => s.active !== false).length;
  const withDesc = svcs.filter((s: any) => s.description).length;

  md += `### ${category} (${svcs.length} services, ${withDesc} with descriptions)\n\n`;

  for (const svc of svcs.sort((a: any, b: any) => (b.defaultPrice || 0) - (a.defaultPrice || 0))) {
    const price = centsToDollars(svc.defaultPrice);
    const duration = svc.defaultDuration ? `${svc.defaultDuration} min` : 'N/A';
    const active = svc.active !== false ? '' : ' *(Inactive)*';
    const desc = svc.description ? escapeMarkdown(svc.description) : '*No description*';

    md += `#### ${escapeMarkdown(svc.name)}${active}\n\n`;
    md += `- **Price**: ${price}\n`;
    md += `- **Duration**: ${duration}\n`;
    md += `- **Description**: ${desc}\n\n`;
  }
}

md += `---

## 4. All Membership Plans

**Total Plans**: ${pricingData.membershipPlans.length}

`;

// Sort by price
const sortedPlans = [...pricingData.membershipPlans]
  .sort((a: any, b: any) => (b.unitPrice || 0) - (a.unitPrice || 0));

for (const plan of sortedPlans) {
  const price = centsToDollars(plan.unitPrice);
  const interval = intervalToText(plan.interval);
  const active = plan.active !== false ? '' : ' *(Inactive)*';
  const desc = plan.description ? escapeMarkdown(plan.description) : '*No description*';

  md += `### ${escapeMarkdown(plan.name)}${active}\n\n`;
  md += `- **Price**: ${price} / ${interval}\n`;
  md += `- **Description**: ${desc}\n\n`;
}

md += `---

## 5. All Products with Descriptions

**Total Products**: ${data.productsWithDescriptions?.length || data.products.length}
**With Descriptions**: ${(data.productsWithDescriptions || []).filter((p: any) => p.description).length}

`;

// Group products by category
const productsByCategory: Record<string, any[]> = {};
const products = data.productsWithDescriptions || data.products;
for (const prod of products) {
  const cat = prod.category?.name || "Uncategorized";
  if (!productsByCategory[cat]) productsByCategory[cat] = [];
  productsByCategory[cat].push(prod);
}

const sortedProductCategories = Object.entries(productsByCategory)
  .sort((a, b) => b[1].length - a[1].length);

for (const [category, prods] of sortedProductCategories) {
  const withDesc = prods.filter((p: any) => p.description).length;

  md += `### ${category} (${prods.length} products, ${withDesc} with descriptions)\n\n`;

  for (const prod of prods.sort((a: any, b: any) => (b.unitPrice || 0) - (a.unitPrice || 0))) {
    const price = centsToDollars(prod.unitPrice);
    const cost = prod.unitCost ? centsToDollars(prod.unitCost) : 'N/A';
    const active = prod.active !== false ? '' : ' *(Inactive)*';
    const desc = prod.description ? escapeMarkdown(prod.description) : '*No description*';
    const barcode = prod.barcode || 'N/A';

    md += `#### ${escapeMarkdown(prod.name)}${active}\n\n`;
    md += `- **Price**: ${price}\n`;
    md += `- **Cost**: ${cost}\n`;
    md += `- **Barcode**: ${barcode}\n`;
    md += `- **Description**: ${desc}\n\n`;
  }
}

md += `---

## 6. Staff & Organization

**Total Staff**: ${data.staff.length.toLocaleString()}
**Average per Location**: ${(data.staff.length / data.locations.length).toFixed(1)}

### Staff by Role

| Role | Count | % of Total |
|------|-------|------------|
`;

const rolesSorted = analyzeStaff();
for (const [role, staff] of rolesSorted) {
  const pct = ((staff.length / data.staff.length) * 100).toFixed(1);
  md += `| ${role} | ${staff.length.toLocaleString()} | ${pct}% |\n`;
}

md += `
### Organizational Structure

- **Aestheticians**: ${rolesSorted.find(([r]) => r === 'Aesthetician')?.[1]?.length || 0} (service providers)
- **Franchise Owners**: ${rolesSorted.find(([r]) => r === 'Franchise Owner')?.[1]?.length || 0}
- **Location Managers**: ${rolesSorted.find(([r]) => r === 'Location Manager')?.[1]?.length || 0}
- **District Managers**: ${rolesSorted.find(([r]) => r === 'District Manager')?.[1]?.length || 0}
- **Receptionists**: ${rolesSorted.find(([r]) => r === 'Receptionists')?.[1]?.length || 0}

---

## 7. Active Memberships Analysis

**Total Active Memberships**: ${data.memberships.length.toLocaleString()}
**Average per Location**: ${(data.memberships.length / data.locations.length).toFixed(0)}

### By Billing Interval

| Interval | Count | % |
|----------|-------|---|
`;

const membershipAnalysis = analyzeMemberships();
for (const [interval, members] of Object.entries(membershipAnalysis.byInterval)) {
  const pct = ((members.length / data.memberships.length) * 100).toFixed(1);
  md += `| ${intervalToText(interval)} | ${members.length.toLocaleString()} | ${pct}% |\n`;
}

md += `
### Top Membership Types by Active Subscribers

| Membership | Active Subscribers | % Share |
|------------|-------------------|---------|
`;

for (const [name, info] of membershipAnalysis.topTypes) {
  const pct = ((info.count / data.memberships.length) * 100).toFixed(1);
  md += `| ${escapeMarkdown(name)} | ${info.count.toLocaleString()} | ${pct}% |\n`;
}

md += `
---

## 8. Client Behavior & Retention

Based on sample of **${(data.clientStats?.sampleSize || 0).toLocaleString()} clients**:

| Metric | Value |
|--------|-------|
| **Repeat Client Rate** | ${data.clientStats?.retentionRate || 'N/A'}% |
| **Avg Appointments/Client** | ${(data.clientStats?.avgAppointmentsPerClient || 0).toFixed(2)} |
| **Max Appointments (Most Loyal)** | ${data.clientStats?.maxAppointments || 'N/A'} |

### Visit Distribution

| Visits | Clients | % |
|--------|---------|---|
`;

if (data.clientStats?.distribution) {
  for (const [range, count] of Object.entries(data.clientStats.distribution)) {
    const pct = (((count as number) / data.clientStats.sampleSize) * 100).toFixed(1);
    md += `| ${range} | ${(count as number).toLocaleString()} | ${pct}% |\n`;
  }
}

md += `
### Acquisition Channels (Top Tags)

| Tag | Count |
|-----|-------|
`;

if (data.clientStats?.topTags) {
  for (const [tag, count] of data.clientStats.topTags.slice(0, 15)) {
    md += `| ${tag} | ${count} |\n`;
  }
}

md += `
---

## 9. Service Popularity

Based on **${(data.servicePopularity?.totalAppointmentsScanned || 0).toLocaleString()} appointments** sampled:

### Top 25 Most Booked Services

| Rank | Service | Bookings | % |
|------|---------|----------|---|
`;

if (data.servicePopularity?.topServices) {
  data.servicePopularity.topServices.slice(0, 25).forEach(([name, count]: [string, number], i: number) => {
    const pct = ((count / data.servicePopularity.totalAppointmentsScanned) * 100).toFixed(1);
    md += `| ${i + 1} | ${escapeMarkdown(name)} | ${count} | ${pct}% |\n`;
  });
}

md += `
---

## 10. Business Model Insights

### Revenue Streams

1. **Memberships** (Primary): ${data.memberships.length.toLocaleString()}+ active subscriptions averaging ~$50/month
2. **A la Carte Services**: Walk-in and one-time services
3. **Laser Hair Removal**: Premium upsell from waxing
4. **Retail Products**: ${data.productsWithDescriptions?.length || data.products.length} products

### Key Metrics

| Metric | Value |
|--------|-------|
| Locations | ${data.locations.length} |
| States | ${analyzeLocations().length} |
| Staff per Location | ${(data.staff.length / data.locations.length).toFixed(1)} |
| Memberships per Location | ${(data.memberships.length / data.locations.length).toFixed(0)} |
| Services Offered | ${services.length} |
| Membership Plans | ${pricingData.membershipPlans.length} |

### Competitive Advantages

1. **National Scale**: ${data.locations.length} locations across ${analyzeLocations().length} states
2. **Recurring Revenue**: Membership model provides predictable income
3. **Service Focus**: Specialized in waxing with clear expertise
4. **Franchise Model**: ${rolesSorted.find(([r]) => r === 'Franchise Owner')?.[1]?.length || 0} franchise owners enable rapid scaling
5. **Upsell Path**: Wax → Laser conversion opportunity

---

## Appendix: Data Sources

| Data Type | Count | Source |
|-----------|-------|--------|
| Locations | ${data.locations.length} | Boulevard API |
| Services | ${services.length} | Boulevard API |
| Membership Plans | ${pricingData.membershipPlans.length} | Boulevard API |
| Active Memberships | ${data.memberships.length} | Boulevard API |
| Products | ${products.length} | Boulevard API |
| Staff | ${data.staff.length} | Boulevard API |
| Client Sample | ${data.clientStats?.sampleSize || 0} | Boulevard API |
| Appointment Sample | ${data.servicePopularity?.totalAppointmentsScanned || 0} | Boulevard API |

**Extraction Timestamps**:
- Initial: ${data.extractedAt}
- Enhanced: ${data.enhancedAt || 'N/A'}
- Descriptions: ${data.descriptionsAddedAt || 'N/A'}

---

*This document was automatically generated for business intelligence and model training purposes.*
*Total size: ~${Math.round(md.length / 1024)}KB*
`;

writeFileSync("HelloSugar.md", md);

console.log("✅ Generated comprehensive HelloSugar.md");
console.log(`   - ${data.locations.length} locations`);
console.log(`   - ${services.length} services (${(data.servicesWithDescriptions || []).filter((s: any) => s.description).length} with descriptions)`);
console.log(`   - ${pricingData.membershipPlans.length} membership plans`);
console.log(`   - ${products.length} products (${(data.productsWithDescriptions || []).filter((p: any) => p.description).length} with descriptions)`);
console.log(`   - ${data.staff.length} staff members`);
console.log(`   - File size: ~${Math.round(md.length / 1024)}KB`);

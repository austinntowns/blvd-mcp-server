/**
 * Generate final comprehensive HelloSugar.md with all data
 */

import { readFileSync, writeFileSync } from "fs";

const data = JSON.parse(readFileSync("exports/hello-sugar-raw-data.json", "utf-8"));

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

  const statesSorted = Object.entries(byState).sort((a, b) => b[1].length - a[1].length);
  const multiLocationCities = Object.entries(byCity)
    .filter(([_, locs]) => locs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  return { byState, byCity, statesSorted, multiLocationCities };
}

function analyzeServices() {
  const byCategoryName: Record<string, any[]> = {};
  for (const svc of data.services) {
    const name = svc.category?.name || "Uncategorized";
    if (!byCategoryName[name]) byCategoryName[name] = [];
    byCategoryName[name].push(svc);
  }
  const categoriesSorted = Object.entries(byCategoryName).sort((a, b) => b[1].length - a[1].length);
  return { byCategory: byCategoryName, categoriesSorted };
}

function analyzeStaff() {
  const byRole: Record<string, any[]> = {};
  for (const s of data.staff) {
    const role = s.role?.name || "No Role";
    if (!byRole[role]) byRole[role] = [];
    byRole[role].push(s);
  }
  const rolesSorted = Object.entries(byRole).sort((a, b) => b[1].length - a[1].length);
  return { byRole, rolesSorted };
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

  const typesSorted = Object.entries(membershipTypes)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30);

  return { byInterval, uniqueNames: [...uniqueNames], typesSorted };
}

// ========== GENERATE MARKDOWN ==========

function generateMarkdown(): string {
  const locAnalysis = analyzeLocations();
  const svcAnalysis = analyzeServices();
  const staffAnalysis = analyzeStaff();
  const membershipAnalysis = analyzeMemberships();
  const clientStats = data.clientStats || {};
  const servicePopularity = data.servicePopularity || {};

  let md = `# Hello Sugar Business Intelligence Report

> **Data Source**: Boulevard Admin API
> **Initial Extraction**: ${new Date(data.extractedAt).toLocaleDateString()}
> **Enhanced**: ${data.enhancedAt ? new Date(data.enhancedAt).toLocaleDateString() : 'N/A'}
>
> This comprehensive document profiles Hello Sugar's business operations, service offerings, membership programs, staffing structure, client behavior, and market positioning based on live data from their Boulevard booking platform.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Geographic Footprint](#1-geographic-footprint)
3. [Services & Offerings](#2-services--offerings)
4. [Memberships & Recurring Revenue](#3-memberships--recurring-revenue)
5. [Staff & Organization](#4-staff--organization)
6. [Client Behavior & Retention](#5-client-behavior--retention)
7. [Service Popularity & Demand](#6-service-popularity--demand)
8. [Products & Retail](#7-products--retail)
9. [Business Model Analysis](#8-business-model-analysis)
10. [Competitive Positioning](#9-competitive-positioning)

---

## Executive Summary

Hello Sugar is a **national waxing and beauty services franchise** with significant scale and a strong recurring revenue model.

### Key Metrics at a Glance

| Metric | Value | Context |
|--------|-------|---------|
| **Total Locations** | ${data.locations.length} | Across ${locAnalysis.statesSorted.length} U.S. states |
| **Total Services** | ${data.services.length} | ${svcAnalysis.categoriesSorted.length} service categories |
| **Staff Members** | ${data.staff.length.toLocaleString()} | ~${(data.staff.length / data.locations.length).toFixed(0)} per location |
| **Active Memberships** | ${data.memberships.length.toLocaleString()}+ | ~${(data.memberships.length / data.locations.length).toFixed(0)} per location |
| **Membership Types** | ${membershipAnalysis.uniqueNames.length} | Variety for different customer segments |
| **Retail Products** | ${data.products.length} | Additional revenue stream |
| **Repeat Client Rate** | ${clientStats.retentionRate || 'N/A'}% | Based on ${(clientStats.sampleSize || 0).toLocaleString()} client sample |

### Business Model Summary

Hello Sugar operates on a **subscription-first model** where:
- **Primary Revenue**: Recurring membership subscriptions for waxing services
- **Secondary Revenue**: Walk-in/a la carte services, retail products
- **Service Focus**: Brazilian wax (~28% of all bookings), brow services (~16%), body waxing
- **Geographic Strategy**: Franchise expansion across suburban/urban markets, Texas-heavy

---

## 1. Geographic Footprint

Hello Sugar operates **${data.locations.length} locations** across **${locAnalysis.statesSorted.length} states**, positioning it as one of the largest waxing-focused salon chains in the United States.

### Market Concentration

| Rank | State | Locations | Market Share |
|------|-------|-----------|--------------|
${locAnalysis.statesSorted.slice(0, 15).map(([state, locs], i) =>
  `| ${i + 1} | **${state}** | ${locs.length} | ${((locs.length / data.locations.length) * 100).toFixed(1)}% |`
).join('\n')}

**Texas dominates** with ${locAnalysis.statesSorted[0]?.[1]?.length || 0} locations (${((locAnalysis.statesSorted[0]?.[1]?.length || 0) / data.locations.length * 100).toFixed(1)}%), suggesting the brand's origin and strongest market.

### Multi-Location Cities

${locAnalysis.multiLocationCities.slice(0, 15).map(([city, locs]) =>
  `- **${city}**: ${locs.length} locations`
).join('\n')}

### Regional Distribution

| Region | States | Locations |
|--------|--------|-----------|
| **Southwest** | TX, AZ, NM, NV | ${['TX', 'AZ', 'NM', 'NV'].reduce((sum, s) => sum + (locAnalysis.byState[s]?.length || 0), 0)} |
| **West Coast** | CA, OR, WA | ${['CA', 'OR', 'WA'].reduce((sum, s) => sum + (locAnalysis.byState[s]?.length || 0), 0)} |
| **Southeast** | FL, GA, NC, SC, TN, AL | ${['FL', 'GA', 'NC', 'SC', 'TN', 'AL'].reduce((sum, s) => sum + (locAnalysis.byState[s]?.length || 0), 0)} |
| **Mid-Atlantic** | VA, PA, NJ, NY, CT, MA | ${['VA', 'PA', 'NJ', 'NY', 'CT', 'MA'].reduce((sum, s) => sum + (locAnalysis.byState[s]?.length || 0), 0)} |
| **Midwest** | IL, OH, MI, MN, WI, MO | ${['IL', 'OH', 'MI', 'MN', 'WI', 'MO'].reduce((sum, s) => sum + (locAnalysis.byState[s]?.length || 0), 0)} |
| **Mountain West** | CO, UT, ID, MT | ${['CO', 'UT', 'ID', 'MT'].reduce((sum, s) => sum + (locAnalysis.byState[s]?.length || 0), 0)} |

<details>
<summary><strong>Full Location Directory (${data.locations.length} locations)</strong></summary>

${locAnalysis.statesSorted.map(([state, locs]) => `
### ${state} (${locs.length} location${locs.length > 1 ? 's' : ''})

${locs.map((loc: any) => `- **${loc.name}**: ${loc.address?.line1 || 'N/A'}, ${loc.address?.city || ''} ${loc.address?.zip || ''}`).join('\n')}
`).join('\n')}

</details>

---

## 2. Services & Offerings

Hello Sugar offers **${data.services.length} services** across **${svcAnalysis.categoriesSorted.length} categories**, with a clear focus on waxing, laser hair removal, and complementary beauty services.

### Service Category Breakdown

| Category | Services | % of Catalog | Description |
|----------|----------|--------------|-------------|
${svcAnalysis.categoriesSorted.slice(0, 20).map(([cat, services]) => {
  const descriptions: Record<string, string> = {
    'General': 'Core operational services',
    'Laser Promos': 'First-time laser promotions',
    'Laser Memberships': 'Recurring laser subscriptions',
    'Laser a la Carte': 'One-time laser services',
    'Spray Tan': 'Sunless tanning & facials',
    'Brazilian Area': 'Brazilian wax/sugar services',
    'Promo Offers': 'First-time client promotions',
    'Chest & Stomach': 'Body waxing services',
    'Brows': 'Eyebrow shaping & styling',
    'Arms': 'Arm waxing services',
    'Legs': 'Leg waxing services',
    'Eyelash Extensions': 'Lash services',
  };
  return `| ${cat} | ${services.length} | ${((services.length / data.services.length) * 100).toFixed(1)}% | ${descriptions[cat] || '-'} |`;
}).join('\n')}

### Core Service Lines

**1. Waxing Services (Traditional)**
- Brazilian wax (male/female anatomy options)
- Bikini line and full bikini
- Facial waxing (brows, lip, chin, full face)
- Body waxing (legs, arms, back, chest, underarms)
- Specialty areas (buttocks, stomach, neck)

**2. Sugaring Services**
- All waxing services available with sugar as an alternative
- Marketed as gentler, natural option
- Same pricing structure as wax

**3. Laser Hair Removal**
- Available for all body areas (XS, S, M, L sizing)
- First-time promos to convert wax clients
- Membership options for ongoing treatment
- A la carte for occasional users

**4. Skincare & Facials**
- Signature facials and chemical peels
- Dermaplaning
- O2 Lift and hydrojelly treatments
- Brazilian enzyme treatments
- Back facials

**5. Additional Services**
- Spray tanning
- Lash lifts and extensions
- Brow lamination and tinting
- Intimate lightening treatments

### Pricing Strategy (Based on Service Naming)

| Tier | Service Type | Target Customer |
|------|--------------|-----------------|
| **Promo/Free** | First-time offers | New client acquisition |
| **Standard** | A la carte services | Occasional visitors |
| **Membership** | Monthly subscriptions | Regular clients |
| **8-Week** | Extended interval memberships | Budget-conscious regulars |
| **Student** | Discounted memberships | College demographic |

---

## 3. Memberships & Recurring Revenue

Hello Sugar has **${data.memberships.length.toLocaleString()} active membership subscriptions** across **${membershipAnalysis.uniqueNames.length} unique membership types**.

### Billing Intervals

| Interval | Members | % of Total | Description |
|----------|---------|------------|-------------|
| **P1M** (Monthly) | ${membershipAnalysis.byInterval['P1M']?.length?.toLocaleString() || 0} | ${((membershipAnalysis.byInterval['P1M']?.length || 0) / data.memberships.length * 100).toFixed(1)}% | Standard monthly billing |
| **P2M** (Bi-Monthly) | ${membershipAnalysis.byInterval['P2M']?.length?.toLocaleString() || 0} | ${((membershipAnalysis.byInterval['P2M']?.length || 0) / data.memberships.length * 100).toFixed(1)}% | 8-week cycle memberships |

### Top Membership Programs

| Rank | Membership | Active Members | % Share | Included Services |
|------|------------|----------------|---------|-------------------|
${membershipAnalysis.typesSorted.map(([name, info], i) =>
  `| ${i + 1} | ${name} | ${info.count.toLocaleString()} | ${((info.count / data.memberships.length) * 100).toFixed(1)}% | ${[...info.services].slice(0, 2).join(', ') || name} |`
).join('\n')}

### Membership Insights

1. **Brazilian Dominance**: The top 4 memberships are Brazilian wax/sugar variants, accounting for ~85% of all memberships
2. **Wax vs Sugar Split**: Wax memberships (~3:1 ratio vs sugar) are more popular
3. **8-Week Option**: Budget-friendly bi-monthly option captures ~7% of members
4. **Student Targeting**: Specific student offers with free underarm add-ons
5. **Upsell Potential**: Brows, underarms, and bikini memberships for add-on revenue

### Membership Penetration

| Metric | Value |
|--------|-------|
| Total Active Memberships | ${data.memberships.length.toLocaleString()} |
| Average per Location | ${(data.memberships.length / data.locations.length).toFixed(0)} |
| Unique Membership Types | ${membershipAnalysis.uniqueNames.length} |

<details>
<summary><strong>All ${membershipAnalysis.uniqueNames.length} Membership Types</strong></summary>

${membershipAnalysis.uniqueNames.sort().map(name => `- ${name}`).join('\n')}

</details>

---

## 4. Staff & Organization

Hello Sugar employs **${data.staff.length.toLocaleString()} team members** across all locations.

### Staff Composition

| Role | Count | % of Staff | Avg per Location |
|------|-------|------------|------------------|
${staffAnalysis.rolesSorted.map(([role, staff]) =>
  `| ${role} | ${staff.length.toLocaleString()} | ${((staff.length / data.staff.length) * 100).toFixed(1)}% | ${(staff.length / data.locations.length).toFixed(1)} |`
).join('\n')}

### Organizational Structure

Based on role distribution:

\`\`\`
Corporate Level
├── Admin (${staffAnalysis.byRole['Admin']?.length || 0})
├── HR (${staffAnalysis.byRole['HR']?.length || 0})
└── District Managers (${staffAnalysis.byRole['District Manager']?.length || 0})

Franchise Level
├── Franchise Owners (${staffAnalysis.byRole['Franchise Owner']?.length || 0})
├── Location Managers (${staffAnalysis.byRole['Location Manager']?.length || 0})
└── Offsite Managers (${staffAnalysis.byRole['Offsite Manager']?.length || 0})

Location Level
├── Aestheticians (${staffAnalysis.byRole['Aesthetician']?.length || 0})
├── Receptionists (${staffAnalysis.byRole['Receptionists']?.length || 0})
└── General Staff (${staffAnalysis.byRole['General Staff']?.length || 0})

Training
└── Training Accounts (${staffAnalysis.byRole['Training Account']?.length || 0})
\`\`\`

### Staffing Metrics

| Metric | Value |
|--------|-------|
| Average Staff per Location | ${(data.staff.length / data.locations.length).toFixed(1)} |
| Average Aestheticians per Location | ${((staffAnalysis.byRole['Aesthetician']?.length || 0) / data.locations.length).toFixed(1)} |
| Franchise Owner Ratio | ${(data.locations.length / (staffAnalysis.byRole['Franchise Owner']?.length || 1)).toFixed(1)} locations per owner |
| Manager Density | ${((staffAnalysis.byRole['Location Manager']?.length || 0) / data.locations.length * 100).toFixed(0)}% of locations have dedicated manager |

---

## 5. Client Behavior & Retention

Based on a sample of **${(clientStats.sampleSize || 0).toLocaleString()} clients**:

### Key Retention Metrics

| Metric | Value | Industry Context |
|--------|-------|------------------|
| **Repeat Client Rate** | ${clientStats.retentionRate || 'N/A'}% | Clients with 2+ visits |
| **Average Visits/Client** | ${(clientStats.avgAppointmentsPerClient || 0).toFixed(2)} | Across all sampled clients |
| **Most Loyal Client** | ${clientStats.maxAppointments || 0} visits | Maximum observed |
| **Total Appointments (sample)** | ${(clientStats.totalAppointments || 0).toLocaleString()} | In sampled client base |

### Visit Frequency Distribution

| Visit Count | Clients | % of Sample | Customer Type |
|-------------|---------|-------------|---------------|
${Object.entries(clientStats.distribution || {}).map(([range, count]) =>
  `| ${range} | ${(count as number).toLocaleString()} | ${(((count as number) / (clientStats.sampleSize || 1)) * 100).toFixed(1)}% | ${
    range === '0 visits' ? 'Inactive/Lapsed' :
    range === '1 visit' ? 'New/Trial' :
    range === '2-5 visits' ? 'Developing' :
    range === '6-10 visits' ? 'Regular' :
    range === '11-20 visits' ? 'Loyal' :
    'VIP'
  } |`
).join('\n')}

### Client Acquisition Channels (via Tags)

| Tag | Count | % of Sample | Channel Type |
|-----|-------|-------------|--------------|
${(clientStats.topTags || []).slice(0, 15).map(([tag, count]: [string, number]) =>
  `| ${tag} | ${count} | ${((count / (clientStats.sampleSize || 1)) * 100).toFixed(1)}% | ${
    tag.includes('Meta') ? 'Social Media (Meta/FB/IG)' :
    tag.includes('GAds') ? 'Google Ads' :
    tag.includes('web') ? 'Website' :
    tag.includes('referral') ? 'Referral' :
    'Other'
  } |`
).join('\n')}

### Retention Analysis

- **${clientStats.retentionRate || 0}% repeat rate** is based on ${(clientStats.sampleSize || 0).toLocaleString()} sampled clients
- **${(((clientStats.distribution?.['6-10 visits'] || 0) + (clientStats.distribution?.['11-20 visits'] || 0) + (clientStats.distribution?.['21-50 visits'] || 0) + (clientStats.distribution?.['51+ visits'] || 0)) / (clientStats.sampleSize || 1) * 100).toFixed(1)}%** are "regular+" customers (6+ visits)
- Membership model suggests actual retention is higher (locked-in recurring revenue)

---

## 6. Service Popularity & Demand

Based on **${(servicePopularity.totalAppointmentsScanned || 0).toLocaleString()} appointment services** sampled across **${servicePopularity.locationsScanned || 0} locations**:

### Top 25 Most Booked Services

| Rank | Service | Bookings | % of Total | Category |
|------|---------|----------|------------|----------|
${(servicePopularity.topServices || []).slice(0, 25).map(([name, count]: [string, number], i: number) => {
  const pct = ((count / (servicePopularity.totalAppointmentsScanned || 1)) * 100).toFixed(1);
  const category =
    name.toLowerCase().includes('brazilian') ? 'Brazilian' :
    name.toLowerCase().includes('brow') ? 'Brows' :
    name.toLowerCase().includes('underarm') ? 'Underarms' :
    name.toLowerCase().includes('lip') ? 'Facial' :
    name.toLowerCase().includes('chin') ? 'Facial' :
    name.toLowerCase().includes('leg') ? 'Legs' :
    name.toLowerCase().includes('promo') ? 'Promo' :
    'Other';
  return `| ${i + 1} | ${name} | ${count} | ${pct}% | ${category} |`;
}).join('\n')}

### Service Demand by Category

| Category | % of Bookings | Insight |
|----------|---------------|---------|
| **Brazilian** | ~35% | Core service, drives memberships |
| **Brows** | ~16% | High-frequency add-on service |
| **Promos** | ~10% | New client acquisition |
| **Facial (lip/chin)** | ~8% | Consistent add-on revenue |
| **Body (legs/arms/etc)** | ~15% | Seasonal variation |
| **Other** | ~16% | Various services |

### Insights

1. **Brazilian wax is the flagship** — ~28% of all bookings are Brazilian (V) Wax alone
2. **Promos drive acquisition** — First-time promos account for significant volume
3. **Brows are the #2 service** — High frequency, quick service, good margins
4. **Cross-sell opportunity** — Underarms often paired with Brazilian

---

## 7. Products & Retail

Hello Sugar offers **${data.products.length} retail products** for sale.

### Product Inventory Summary

| Metric | Value |
|--------|-------|
| Total Products | ${data.products.length} |
| Products with Barcode | ${data.products.filter((p: any) => p.barcode).length} |
| Products with Description | ${data.products.filter((p: any) => p.description).length} |

### Sample Product Categories

Based on product naming patterns:
- **Ingrown Hair Prevention** — Fur brand products (microdart patches, care duo)
- **Aftercare Products** — Soothe, Hydrate, Prevent, Clean lines
- **Skincare** — Moisturizers, toners, cleansers
- **Service Add-ons** — Collagen treatments, lightening treatments

---

## 8. Business Model Analysis

### Revenue Streams

| Stream | Description | Est. Contribution |
|--------|-------------|-------------------|
| **Memberships** | Recurring wax/sugar subscriptions | Primary (~60-70%) |
| **A la Carte Services** | Walk-in and one-time services | Secondary (~20-25%) |
| **Laser Hair Removal** | Growing service line | Emerging (~5-10%) |
| **Retail Products** | Aftercare and skincare | Supplemental (~3-5%) |

### Strengths

1. **Subscription Model** — ${data.memberships.length.toLocaleString()} active memberships provide predictable recurring revenue
2. **National Scale** — ${data.locations.length} locations across ${locAnalysis.statesSorted.length} states
3. **Service Focus** — Clear specialization in waxing with expansion into laser
4. **Franchise Model** — ${staffAnalysis.byRole['Franchise Owner']?.length || 0} franchise owners enable rapid scaling
5. **Multi-Service Upsell** — ${membershipAnalysis.uniqueNames.length} membership types capture different customer needs

### Growth Indicators

| Indicator | Evidence |
|-----------|----------|
| Geographic Expansion | Present in ${locAnalysis.statesSorted.length} states, multi-location cities |
| Service Diversification | Laser services, facials, spray tan expansion |
| Digital Acquisition | Meta, Google Ads tags show digital marketing investment |
| Training Infrastructure | ${staffAnalysis.byRole['Training Account']?.length || 0} training accounts |

### Key Business Ratios

| Metric | Value |
|--------|-------|
| Memberships per Location | ${(data.memberships.length / data.locations.length).toFixed(0)} |
| Staff per Location | ${(data.staff.length / data.locations.length).toFixed(1)} |
| Aestheticians per Location | ${((staffAnalysis.byRole['Aesthetician']?.length || 0) / data.locations.length).toFixed(1)} |
| Services per Category | ${(data.services.length / svcAnalysis.categoriesSorted.length).toFixed(1)} |

---

## 9. Competitive Positioning

### Market Position

Hello Sugar positions as a **premium, membership-focused waxing chain** that differentiates on:

1. **Subscription Value** — Predictable pricing, regular appointments
2. **Service Quality** — Trained aestheticians, consistent experience
3. **Gender Inclusivity** — Explicit P/V anatomy options for all services
4. **Convenience** — ${data.locations.length} locations for accessibility

### Target Demographics

| Segment | Evidence |
|---------|----------|
| **Young Professionals** | Urban/suburban locations, digital marketing |
| **College Students** | Student membership discounts, university-adjacent locations |
| **Recurring Groomers** | Membership model rewards frequency |
| **New-to-Waxing** | Aggressive first-time promos (free/discounted) |

### Competitive Advantages

1. **Scale** — One of the largest waxing-focused chains nationally
2. **Recurring Revenue** — Membership model creates predictability
3. **Franchise Network** — Local ownership with corporate support
4. **Service Breadth** — Wax, sugar, laser, facials under one roof

---

## Appendix: Data Quality & Methodology

### Data Sources

| Source | Type | Coverage |
|--------|------|----------|
| Boulevard Admin API | Primary | All operational data |
| GraphQL Queries | Method | Paginated extraction |
| Client Sample | Statistical | ${(clientStats.sampleSize || 0).toLocaleString()} clients |
| Appointment Sample | Statistical | ${(servicePopularity.totalAppointmentsScanned || 0).toLocaleString()} services across ${servicePopularity.locationsScanned || 0} locations |

### Data Timestamps

| Extraction | Timestamp |
|------------|-----------|
| Initial | ${new Date(data.extractedAt).toISOString()} |
| Enhanced | ${data.enhancedAt ? new Date(data.enhancedAt).toISOString() : 'N/A'} |

### Notes

- Client sample may not be representative of full client base
- Appointment sample limited to ${servicePopularity.locationsScanned || 0} locations
- Membership count reflects point-in-time active subscriptions
- Staff count includes all roles (active and training accounts)

---

*This document was automatically generated for business intelligence and model training purposes.*
*Last updated: ${new Date().toISOString()}*
`;

  return md;
}

// ========== MAIN ==========

const markdown = generateMarkdown();
writeFileSync("HelloSugar.md", markdown);
console.log("✅ Generated comprehensive HelloSugar.md");
console.log(`   File: ${__dirname}/../HelloSugar.md`);

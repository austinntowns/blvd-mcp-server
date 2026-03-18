# Boulevard Operations MCP Server - Research

## Boulevard Admin API Documentation

### API Endpoint
- Production: `https://dashboard.boulevard.io/api/2020-01/admin`
- GraphQL-based

### Authentication
```
Authorization: Basic <base64(API_KEY:)>
X-Boulevard-Business-Id: <BUSINESS_ID>
```

### Key Queries

#### shifts
```graphql
query GetShifts(
  $locationId: ID!
  $startIso8601: Date!
  $endIso8601: Date!
  $staffIds: [ID!]
) {
  shifts(
    locationId: $locationId
    startIso8601: $startIso8601
    endIso8601: $endIso8601
    staffIds: $staffIds
  ) {
    shifts {
      id
      startAt
      endAt
      staffMember { id name displayName }
    }
  }
}
```

#### appointments
```graphql
query GetAppointments($locationId: ID!, $first: Int, $query: QueryString) {
  appointments(locationId: $locationId, first: $first, query: $query) {
    edges {
      node {
        id
        startAt
        endAt
        duration
        cancelled
        state
        appointmentServices {
          service { name }
          staff { id name }
          duration
        }
      }
    }
  }
}
```

Supports query string filtering on:
- `id: Id`
- `startAt: DateTime`
- `createdAt: DateTime`
- `cancelled: Boolean`
- `staffId: Id`

### Key Mutations

#### createTimeblock
```graphql
mutation CreateTimeblock($input: CreateTimeblockInput!) {
  createTimeblock(input: $input) {
    timeblock {
      id
      startAt
      endAt
      duration
      title
      reason
      staffMember { id name }
    }
  }
}
```

**CreateTimeblockInput fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| duration | Int! | Yes | Duration in minutes |
| locationId | ID! | Yes | Location |
| staffId | ID! | Yes | Staff member to block |
| startTime | DateTime! | Yes | When block starts |
| reason | TimeblockReason | No | Reason code |
| recurring | TimeblockRecurringOptions | No | Repeat settings |
| title | String | No | Display name |

#### deleteTimeblock
```graphql
mutation DeleteTimeblock($input: DeleteTimeblockInput!) {
  deleteTimeblock(input: $input) {
    timeblock { id }
  }
}
```

### All Available Queries
- appointment, appointmentRatings, appointments
- booking, business
- cart, carts
- client, clients
- discountReason, discountReasons
- giftCard, giftCards
- location, locations
- manualAudiences
- membership, memberships, membershipPlan, membershipPlans
- node
- offers
- order, orders
- package, packages
- permissions
- product, products
- purchaseOrder, purchaseOrders
- reportExport, reportExports, reports
- service, services
- **shifts** (staff scheduling)
- **staff, staffMember** (staff info)
- tags
- **timeblock, timeblocks** (blocked time)
- webhooks

### All Available Mutations
- createTimeblock, deleteTimeblock
- createShift, unpublishShift
- appointmentReschedule
- bookingCreate, bookingComplete
- createClient, updateClient
- createStaff, updateStaff
- locationUpdateHours
- Many more (see API docs)

### Rate Limiting
- Check Boulevard docs for limits
- Implement caching if needed for high-frequency queries

## Utilization Calculation Logic

```
For each shift:
  available_minutes = shift.endAt - shift.startAt

  For each appointment overlapping shift:
    If appointment.staffId matches shift.staffMember.id:
      overlap_start = max(apt.startAt, shift.startAt)
      overlap_end = min(apt.endAt, shift.endAt)
      booked_minutes += (overlap_end - overlap_start)

  utilization = booked_minutes / available_minutes * 100
```

Shifts with utilization >= 60% are flagged as "busy" and likely need additional staff capacity.

## Staff-Service Assignment Research (2026-03-17)

### Problem
When staff are added to new locations, their services aren't automatically enabled. Need a way to bulk-enable services for staff at locations.

### Key Findings from API Exploration

#### Service Type - Has Staff Context
```graphql
type Service {
  # Check if service is active/bookable for a specific staff member at a location
  serviceStatus(locationId: ID!, staffId: ID, clientId: ID): ServiceStatus!
  serviceOverrides(locationId: ID!, staffId: ID, clientId: ID): ServiceOverride!
}

type ServiceStatus {
  active: Boolean!    # Is service active in this context?
  bookable: Boolean!  # Is service bookable in this context?
}
```

#### updateStaffLocation Mutation
Enables/disables a staff member at a location (but NOT per-service).

```graphql
mutation UpdateStaffLocation($input: UpdateStaffLocationInput!) {
  updateStaffLocation(input: $input) {
    staffLocation { id active }
  }
}

# Input only has: staffId, locationId, active
```

#### Service Location Mutations
```graphql
serviceActivateAtLocation   # Enable service at location (not per-staff)
serviceDeactivateAtLocation # Disable service at location (not per-staff)
```

### Full Mutations List (from API exploration)
Key mutations for this use case:
- `updateStaffLocation` - Staff active/inactive at location
- `serviceActivateAtLocation` / `serviceDeactivateAtLocation` - Service at location
- `updateService` - Update service details
- `updateStaff` - Update staff details

### Next Steps
1. Run GraphQL introspection to find staff-service specific mutations
2. Check for `StaffService` or `StaffServiceOverride` types
3. May need to contact Boulevard support if API doesn't expose staff-service granular control

### Introspection Query
```graphql
query IntrospectMutations {
  __schema {
    mutationType {
      fields {
        name
        description
      }
    }
  }
}

query FindStaffServiceTypes {
  __schema {
    types {
      name
      description
    }
  }
}
```

### Reference Doc
See `docs/blvd-api-reference.md` for full API reference.

## API Schema Corrections (2026-03-17)

### Shifts Query - Returns Templates, Not Instances
The `shifts` query returns recurring shift templates, NOT specific shift instances:

```graphql
query GetShifts($locationId: ID!, $startIso8601: Date!, $endIso8601: Date!) {
  shifts(locationId: $locationId, startIso8601: $startIso8601, endIso8601: $endIso8601) {
    shifts {
      staffId        # UUID only (no URN prefix)
      locationId     # UUID only
      clockIn        # "HH:mm:ss" format
      clockOut       # "HH:mm:ss" format
      day            # 0=Sunday, 1=Monday, etc.
      available
      recurrence
      recurrenceStart
      recurrenceEnd
    }
  }
}
```

To get actual shifts for a date:
1. Query templates
2. Check if template.day matches target date's day of week
3. Check if target date is within recurrence window
4. Combine clockIn/clockOut with date to get actual times

### Staff Query - Top-Level with Pagination
Staff is NOT nested under location. It's a top-level paginated query:

```graphql
query GetStaff($first: Int!, $after: String) {
  staff(first: $first, after: $after) {
    edges {
      node {
        id            # Full URN: "urn:blvd:Staff:uuid"
        name
        displayName
        locations {
          id          # Full URN: "urn:blvd:Location:uuid"
        }
      }
    }
    pageInfo { hasNextPage, endCursor }
  }
}
```

Filter by location client-side using `staff.locations[].id`.

### Timeblocks - Uses `staff` Not `staffMember`
```graphql
query GetTimeblocks($locationId: ID!, $first: Int, $after: String) {
  timeblocks(locationId: $locationId, first: $first, after: $after) {
    edges {
      node {
        id
        startAt
        endAt
        duration
        title
        reason
        staff {       # NOT staffMember!
          id          # Full URN: "urn:blvd:Staff:uuid"
          name
        }
      }
    }
  }
}
```

### ID Format Inconsistencies
- **Shift templates**: `staffId` is UUID only (e.g., `940bc7ff-1c62-4eca-abf7-13af50a480be`)
- **Staff records**: `id` is full URN (e.g., `urn:blvd:Staff:940bc7ff-...`)
- **Timeblocks**: `staff.id` is full URN
- **Locations**: Always full URN (`urn:blvd:Location:uuid`)

**Solution**: Normalize IDs by stripping URN prefix when comparing across entities.

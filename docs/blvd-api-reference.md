# Boulevard Admin API Reference

Quick reference for Boulevard Admin GraphQL API. Full docs: https://developers.joinblvd.com/2020-01/admin-api/overview

## Endpoints

- **Production:** `https://dashboard.boulevard.io/api/2020-01/admin`
- **Sandbox:** `https://sandbox.joinblvd.com/api/2020-01/admin`

## Authentication

HMAC-SHA256 signed Basic Auth (see `lib/boulevard.ts` for implementation).

---

## Staff & Location Management

### updateStaffLocation
Enable/disable a staff member at a location.

```graphql
mutation UpdateStaffLocation($input: UpdateStaffLocationInput!) {
  updateStaffLocation(input: $input) {
    staffLocation {
      id
      active
      staff { id name }
      location { id name }
    }
  }
}
```

**Input:**
| Field | Type | Description |
|-------|------|-------------|
| staffId | ID! | Staff member ID |
| locationId | ID! | Location ID |
| active | Boolean! | Whether staff is active at this location |

### updateStaff
Update staff member details.

```graphql
mutation UpdateStaff($input: UpdateStaffInput!) {
  updateStaff(input: $input) {
    staff { id name displayName }
  }
}
```

### createStaff
Create a new staff member.

```graphql
mutation CreateStaff($input: CreateStaffInput!) {
  createStaff(input: $input) {
    staff { id firstName lastName }
  }
}
```

---

## Service Management

### Service Type
```graphql
type Service {
  id: ID!
  name: String!
  active: Boolean!
  addon: Boolean!
  category: ServiceCategory!
  defaultDuration: Int!
  defaultPrice: Int!  # in cents
  description: String

  # Get service status for specific context
  serviceStatus(locationId: ID!, staffId: ID, clientId: ID): ServiceStatus!

  # Get service overrides (price/duration)
  serviceOverrides(locationId: ID!, staffId: ID, clientId: ID): ServiceOverride!
}

type ServiceStatus {
  active: Boolean!    # Is service active in this context?
  bookable: Boolean!  # Is service bookable in this context?
}
```

### serviceActivateAtLocation
Activate a service at a specific location.

```graphql
mutation ServiceActivateAtLocation($input: ServiceActivateAtLocationInput!) {
  serviceActivateAtLocation(input: $input) {
    service { id name active }
  }
}
```

### serviceDeactivateAtLocation
Deactivate a service at a specific location.

```graphql
mutation ServiceDeactivateAtLocation($input: ServiceDeactivateAtLocationInput!) {
  serviceDeactivateAtLocation(input: $input) {
    service { id name }
  }
}
```

---

## Querying Services

### List all services
```graphql
query GetServices($first: Int!) {
  services(first: $first) {
    edges {
      node {
        id
        name
        active
        defaultDuration
        defaultPrice
        category { id name }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### Get service status for staff at location
```graphql
query GetServiceStatusForStaff($serviceId: ID!, $locationId: ID!, $staffId: ID!) {
  service(id: $serviceId) {
    id
    name
    serviceStatus(locationId: $locationId, staffId: $staffId) {
      active
      bookable
    }
  }
}
```

---

## Staff Type

```graphql
type Staff {
  id: ID!
  name: String!
  displayName: String!
  firstName: String!
  lastName: String
  email: Email
  mobilePhone: PhoneNumber
  active: Boolean
  externallyBookable: Boolean
  enabledForFutureLocations: Boolean!
  locations: [Location!]
  role: StaffRole!
  staffRoleId: ID!
  locationAbilities(locationId: ID!): StaffLocationAbilities!
}
```

---

## Location Type

```graphql
type Location {
  id: ID!
  name: String!
  address: Address
  businessHours: [BusinessHours!]
  staff(first: Int!): StaffConnection!
}
```

---

## Key Queries

| Query | Description |
|-------|-------------|
| `locations(first: Int!)` | List all locations |
| `location(id: ID!)` | Get single location |
| `services(first: Int!)` | List all services |
| `service(id: ID!)` | Get single service |
| `staff(first: Int!)` | List all staff |
| `staffMember(id: ID!)` | Get single staff member |
| `shifts(locationId: ID!, startIso8601: Date!, endIso8601: Date!)` | Get staff shifts |
| `appointments(locationId: ID!, first: Int, query: QueryString)` | List appointments |
| `timeblocks(locationId: ID!, staffId: ID)` | List blocked time |

---

## Key Mutations

| Mutation | Description |
|----------|-------------|
| `createStaff` | Create new staff member |
| `updateStaff` | Update staff details |
| `updateStaffLocation` | Enable/disable staff at location |
| `createShift` | Create staff shift |
| `unpublishShift` | Remove shift |
| `createTimeblock` | Block time on calendar |
| `deleteTimeblock` | Remove blocked time |
| `serviceActivateAtLocation` | Enable service at location |
| `serviceDeactivateAtLocation` | Disable service at location |
| `createService` | Create new service |
| `updateService` | Update service details |
| `bookingCreate` | Start a booking |
| `bookingComplete` | Complete a booking |
| `cancelAppointment` | Cancel an appointment |

---

## TODO: Staff-Service Assignment Research

**Problem:** When staff are added to new locations, services aren't automatically enabled for them.

**What we know:**
- `serviceStatus(locationId, staffId)` on Service type shows if a service is active/bookable for a staff member
- `updateStaffLocation` controls whether staff is active at a location (not per-service)
- `serviceActivateAtLocation` controls service availability at location level (not per-staff)

**Still needed:**
- Mutation to enable specific services for a specific staff member at a location
- May require introspection query to find additional mutations
- Possible candidates: look for `StaffService`, `StaffServiceOverride`, or similar types

**Introspection query to find all mutations:**
```graphql
query IntrospectMutations {
  __schema {
    mutationType {
      fields {
        name
        description
        args { name type { name } }
      }
    }
  }
}
```

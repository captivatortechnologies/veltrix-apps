# 🔭 OpenCTI

Manage [OpenCTI](https://filigran.io/solutions/open-cti/) — the open-source cyber
threat-intelligence platform — as code on the Veltrix Security-as-Code platform.
Author threat-intel configuration in the Configuration Canvas and drive it through
the pipeline (validate → deploy → rollback → health-check → drift-detect → status).

## How it's managed

OpenCTI exposes a single **GraphQL API** over HTTPS. This app applies configuration
over that API:

- **HTTPS GraphQL** — `POST /graphql`. Authentication is your OpenCTI **API token**
  (Profile → API access) carried as a **Bearer token** in the `Authorization`
  header, stored as the connection credential's API token. Self-hosted OpenCTI
  commonly ships a **self-signed certificate**, which the transport tolerates.

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Marking Definitions** | `markingDefinitions` / `markingDefinitionAdd` / `markingDefinitionFieldPatch` / `markingDefinitionDelete` | ✅ v0.1.0 |
| **Labels** | `labels` / `labelAdd` / `labelFieldPatch` / `labelDelete` | ✅ v0.2.0 |
| **Groups** | `groups` / `groupAdd` / `groupEdit(id){ fieldPatch }` / `groupDelete` | ✅ v0.2.0 |
| **Ingestion Feeds (TAXII2)** | `ingestionTaxiis` / `ingestionTaxiiAdd` / `ingestionTaxiiEdit` / `ingestionTaxiiDelete` | ✅ v0.2.0 |
| Kill-chain phases | `killChainPhases` | planned |
| Connectors | `connectors` | planned |
| Roles | `roles` | planned |

Each config type upserts by a stable identity — the marking `definition` (e.g.
`TLP:AMBER`), the label `value`, the group `name`, the feed `name` — used to choose
add vs field-patch and to detect drift; deploy snapshots the prior node so rollback
can restore it (or delete an object it created).

## GraphQL operations

All operations run against `POST <base>/graphql` with `Authorization: Bearer <token>`.
Every `EditInput` is `{ key, value: [String] }` (numbers and booleans stringified).

**Connectivity / health:** `query { about { version } }` (fallback `query { me { id name } }`)

**Marking Definitions**
- **List:** `markingDefinitions { edges { node { id standard_id definition definition_type x_opencti_color x_opencti_order } } }`
- **Create:** `markingDefinitionAdd(input: MarkingDefinitionAddInput!)` — input `{ definition_type, definition, x_opencti_color?, x_opencti_order? }`
- **Update:** `markingDefinitionFieldPatch(id: ID!, input: [EditInput!]!)`
- **Delete:** `markingDefinitionDelete(id: ID!)`

**Labels**
- **List:** `labels { edges { node { id value color } } }`
- **Create:** `labelAdd(input: LabelAddInput!)` — input `{ value, color? }`
- **Update:** `labelFieldPatch(id: ID!, input: [EditInput!]!)`
- **Delete:** `labelDelete(id: ID!)`

**Groups**
- **List:** `groups { edges { node { id name description default_assignation auto_new_marking } } }`
- **Create:** `groupAdd(input: GroupAddInput!)` — input `{ name, description?, default_assignation?, auto_new_marking? }`
- **Update:** `groupEdit(id: ID!) { fieldPatch(input: [EditInput!]!) }`
- **Delete:** `groupDelete(id: ID!)`

**Ingestion Feeds (TAXII2)**
- **List:** `ingestionTaxiis { edges { node { id name uri collection version authentication_type ingestion_running } } }`
- **Create:** `ingestionTaxiiAdd(input: IngestionTaxiiAddInput!)` — input `{ name, uri, collection, version, authentication_type, authentication_value?, added_after_start? }`
- **Update:** `ingestionTaxiiEdit(id: ID!, input: [EditInput!]!)`
- **Delete:** `ingestionTaxiiDelete(id: ID!)`

## Notes

The GraphQL operation and field names above follow OpenCTI conventions and should be
**verified against a live OpenCTI instance**. Specific items flagged in-code as
unverified:

- the `about { version }` probe and the `EditInput` value-as-string-list shape
  (numbers/booleans sent as strings, e.g. `["true"]`);
- **Groups** — the edit shape (`groupEdit(id){ fieldPatch }` vs a top-level
  `groupFieldPatch`), the delete (`groupDelete` vs `groupEdit(id){ delete }`), and
  whether `auto_new_marking` is selectable in the list query;
- **Ingestion Feeds** — the list field (`ingestionTaxiis` vs
  `ingestionTaxiiConnections`) and the `IngestionTaxiiAddInput` field names. The
  secret `authentication_value` is write-only — it is never read back, so drift and
  rollback do not compare or restore it.

TLS verification is off by default (self-signed) and configurable via the
`verify_tls` setting.

Apache-2.0.

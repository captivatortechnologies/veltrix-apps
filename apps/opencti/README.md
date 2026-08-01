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
| Labels | `labels` | planned |
| Kill-chain phases | `killChainPhases` | planned |
| Connectors | `connectors` | planned |
| Groups & roles | `groups` / `roles` | planned |

The marking `definition` value (e.g. `TLP:AMBER`) is the stable identity used to
upsert (add vs field-patch) and to detect drift; deploy snapshots the prior marking
node so rollback can restore it (or delete a marking it created).

## GraphQL operations

All operations run against `POST <base>/graphql` with `Authorization: Bearer <token>`:

- **Connectivity / health:** `query { about { version } }` (fallback `query { me { id name } }`)
- **List:** `markingDefinitions { edges { node { id standard_id definition definition_type x_opencti_color x_opencti_order } } }`
- **Create:** `markingDefinitionAdd(input: MarkingDefinitionAddInput!)` — input `{ definition_type, definition, x_opencti_color?, x_opencti_order? }`
- **Update:** `markingDefinitionFieldPatch(id: ID!, input: [EditInput!]!)` — each `EditInput` is `{ key, value: [String] }`
- **Delete:** `markingDefinitionDelete(id: ID!)` → returns the deleted id

## Notes

The GraphQL operation and field names above follow OpenCTI conventions and should be
**verified against a live OpenCTI instance** — in particular the `about { version }`
probe, the `EditInput` value-as-string-list shape used by `markingDefinitionFieldPatch`,
and the `MarkingDefinitionAddInput` field names. TLS verification is off by default
(self-signed) and configurable via the `verify_tls` setting.

Apache-2.0.

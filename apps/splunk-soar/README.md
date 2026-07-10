# Splunk SOAR (Veltrix App)

Connect Veltrix to **Splunk SOAR** (Security Orchestration, Automation and
Response, formerly Phantom). This app manages the SOAR instance *connection
profile* as code — the endpoint, credential, TLS verification, request
timeout, and retries the platform uses to reach your SOAR deployment — flowing
through the Veltrix pipeline: validate → deploy → health check → drift detect →
rollback.

A connection profile is **how the platform reaches SOAR**; it is not pushed to
SOAR. "Deploy" therefore verifies reachability (`GET /rest/version`) rather than
writing any state, and rollback has nothing to undo.

## Configuration types

| Type | What it manages | SOAR endpoints |
|------|-----------------|----------------|
| `connection` | SOAR instance connection profile: name, description; endpoint reachability, TLS, timeout, retries | `GET /rest/version` |

## Prerequisites

1. **A Splunk SOAR deployment** reachable from the platform over HTTPS (the
   REST API is served on the web port, default `443`).
2. **A component** of type `soar-instance` whose hostname is your SOAR host
   (e.g. `soar.example.com`).
3. **A credential** assigned to the component's tool: the **automation API
   token** (from the SOAR console under **User Settings → API Access**) in the
   `API token` field. Basic auth (`username` / `password`) is supported as a
   fallback. The token is sent as the `ph-auth-token` header.
4. **Connectivity** to the instance (direct HTTPS or a connectivity provider
   such as Tailscale).

## App settings

| Setting | Default | Notes |
|---------|---------|-------|
| `verify_ssl` | `true` | Verify the SOAR instance's TLS certificate on every request |
| `request_timeout_seconds` | `30` | Per-request timeout for SOAR REST calls |
| `max_retries` | `3` | Number of times to retry a failed SOAR REST request |

## Canvas model

Each canvas **section** describes one connection profile.

### `connection` fields

| Field | Constraint |
|-------|-----------|
| `name` | Required. Unique per canvas; max 120 chars. |
| `description` | Optional notes (environment, owner, purpose). |

## Pipeline semantics

- **validate** — every section needs a non-empty, unique connection name.
- **deploy** — verifies the instance is reachable and authenticating
  (`GET /rest/version`); returns an empty `rollbackData` (no external state).
- **rollback** — no-op; there is no external state to revert.
- **healthCheck** — a single `server_reachable` check (`GET /rest/version`);
  fails closed when credential or connectivity is missing.
- **driftDetect** — reachability only; a reachable instance reports no drift, an
  unreachable one reports a critical diff.

## Research sources

- [Splunk SOAR documentation](https://docs.splunk.com/Documentation/SOAR)
- [Splunk SOAR REST API reference](https://docs.splunk.com/Documentation/SOAR/current/PlatformAPI/RESTQueryData)

## License

Apache-2.0

# Greenbone (Veltrix app)

Manage **Greenbone / OpenVAS** vulnerability scanning **as code**. Author scan
**Targets** in the Configuration Canvas and drive them through the Veltrix
Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback.

- **Category:** COMPLIANCE
- **Version:** 0.1.0 (foundation)
- **Manages:** Scan Targets (name, hosts, exclude hosts, port list)

## The transport is GMP, not REST

Greenbone is configured through the **Greenbone Management Protocol (GMP)** — a
human-readable, XML request/response protocol spoken over a **raw TLS socket**
(gvmd's classic listener is TLS on **port 9390**). There is no REST API. The whole
transport is isolated in [`lib/greenboneApi.ts`](./lib/greenboneApi.ts):

- opens a `node:tls` socket to gvmd,
- sends `<authenticate><credentials><username>…</username><password>…</password></credentials></authenticate>`
  (GMP is stateful on the connection — the first command must authenticate; the
  same socket is then authorised for every following command),
- sends one GMP XML command and reads exactly one XML response,
- a minimal hand-rolled XML builder/parser handles `create_target`, `get_targets`,
  `modify_target`, `delete_target` and reads the `status` / `status_text` / `id`
  attributes off the response.

No external XML library is used (`node:tls` + a tiny build/parse). The transport is
a deliberately swappable seam — a unix-socket / SSH-tunnel transport can be added
behind the same `GmpSession` interface.

### Authentication / credentials

A Greenbone **username + password** (the same credentials as the web UI) for a user
with permission to manage targets. Store them as a Veltrix credential on the
**Connections** page (the connection manager's default Password auth). GMP has no
API token.

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `gmp_port` | `9390` | TLS port gvmd listens on for GMP |
| `verify_tls` | `false` | Enforce a valid TLS cert (gvmd usually ships self-signed) |

## Scan Targets

A target is a **named** set of hosts (CIDRs / IPs / hostnames) plus the **port
list** to scan. The target **name** is the stable identity used to upsert:

- **deploy** — `get_targets` (all rows) → `modify_target` if a target with that
  name exists, else `create_target`; records rollback data per target.
- **rollback** — `delete_target` (ultimate) for a target we created, or
  `modify_target` to restore the prior fields for one we modified.
- **healthCheck** — connect + authenticate + `get_version`.
- **driftDetect** — compare declared hosts / exclude-hosts / port-list / comment
  against the live target (best-effort).

Port lists are referenced by UUID. The default is **All IANA assigned TCP**
(`33d0cd82-57c6-11e1-8ed1-406186ea4fc5`, 5836 ports).

## Verify against a live gvmd (FLAGS)

GMP is **version-specific**; the shapes here follow the GMP 22.5 reference and
python-gvm and should be confirmed against your appliance:

- **Response framing** — GMP is not length-framed. The reader accumulates bytes
  until the single top-level response element is closed. `isCompleteGmpResponse()`
  is a minimal "root element closed" detector, not a full XML parser.
- **TLS:9390 is deprecated** in newer Greenbone OS in favour of an SSH-tunnelled
  unix socket. This foundation speaks TLS:9390; another transport can slot behind
  the same seam.
- **TLS trust** — self-signed tolerated by default (`verify_tls` to enforce). Some
  deployments additionally require a **client** certificate (not handled yet).
- **`modify_target`** — gvmd rejects changing `hosts` / `port_list` while the target
  is in use by a task (status 400); surfaced as an error.

## Roadmap

- **BYOL infrastructure hosting** for the Greenbone stack (gvmd + scanner + feed +
  PostgreSQL) — **planned for a later wave**. No database is bundled in this
  foundation.
- More config types (scan configs, scanners, schedules, credentials, tasks).

## References

- GMP 22.5 command reference — https://docs.greenbone.net/API/GMP/gmp-22.5.html
- python-gvm (TLSConnection, `Gmp(connection).authenticate`) —
  https://greenbone.github.io/python-gvm/
- Using GMP (GOS manual) —
  https://docs.greenbone.net/GSM-Manual/gos-22.04/en/gmp.html

## Development

```bash
npm run typecheck                 # tsc --noEmit (from apps/greenbone)
node scripts/validate-app.mjs apps/greenbone   # from the repo root
node scripts/test-apps.mjs greenbone           # XML build/parse + validate unit tests
```

The pipeline handlers talk to gvmd over a live TLS socket, which cannot be mocked;
the unit tests cover the pure seams the socket path is built on (the GMP XML command
assembly + response parsing, and `validate.ts`).

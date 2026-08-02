# Greenbone (Veltrix app)

Manage **Greenbone / OpenVAS** vulnerability scanning **as code**. Author scan
**Targets**, **Port Lists**, **Schedules** and **Scan Tasks** in the Configuration
Canvas and drive them through the Veltrix Security-as-Code pipeline — validate,
deploy, health check, drift detection and rollback.

- **Category:** COMPLIANCE
- **Version:** 0.2.0
- **Manages:** Scan Targets, Port Lists, Schedules, Scan Tasks — all over GMP

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
(`33d0cd82-57c6-11e1-8ed1-406186ea4fc5`, 5836 ports) — or author your own with the
**Port Lists** config type below.

## Port Lists

A named set of TCP/UDP port ranges (`create_port_list` / `get_port_lists` /
`modify_port_list` / `delete_port_list`). The canvas range string
(`T:1-1024,U:53,T:3389`) is normalised to the same canonical form gvmd's structured
`<port_range>` triples reconstruct to, so drift compares cleanly. **FLAG:**
`modify_port_list` only changes name/comment — the port **ranges are immutable via
modify** (a range edit needs a recreate); deploy surfaces a changed range instead of
silently dropping it, and drift flags it.

## Schedules

A named recurrence expressed as **iCalendar (RFC 5545)** data plus a timezone
(`create_schedule` / `get_schedules` / `modify_schedule` / `delete_schedule`).
**FLAG:** the `<icalendar>` element is **GMP 20.08+** (it replaced the old
`first_time` / `period` / `duration` model). gvmd keeps only **DTSTART / DTEND /
DURATION / RRULE** from the VEVENT and reformats the rest, so drift compares those
extracted keys, not the raw text.

## Scan Tasks

Tie a **target** to a **scan config** and a **scanner** (and optionally a
**schedule**) — `create_task` / `get_tasks` / `modify_task` / `delete_task`. Each
foreign key is referenced **by name** (or a pasted UUID) in the canvas and resolved
to a gvmd id at deploy time by reading `get_targets` / `get_configs` /
`get_scanners` / `get_schedules`. Config and scanner default to **Full and fast** /
**OpenVAS Default**. **FLAG:** `create_task` needs `<usage_type>scan</usage_type>`
(GMP 9.0+) and references config/target/scanner as **empty id-bearing elements**;
`modify_task` **cannot re-point** them on a task that has already run unless the task
is *alterable* (gvmd #1305), so deploy only re-sends a foreign key that actually
changed.

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
  PostgreSQL) — **deferred to wave 3**. No database is bundled yet.
- More config types (scan configs, scanners, credentials, alerts).

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

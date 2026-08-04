# Greenbone (Veltrix app)

Manage **Greenbone / OpenVAS** vulnerability scanning **as code**. Author scan
**Targets**, **Port Lists**, **Schedules**, **Scan Tasks**, **Scan Configs**,
**Scanners**, **Alerts**, **Filters**, **Tags**, **Groups**, **Roles**,
**Permissions**, **Report Formats**, **Overrides** and **Notes** in the
Configuration Canvas and drive them through the Veltrix Security-as-Code
pipeline — validate, deploy, health check, drift detection and rollback.

- **Category:** COMPLIANCE
- **Version:** 0.4.0
- **Manages:** 15 configuration types, all over GMP — see [Coverage](#coverage-v040) below.

## The transport is GMP, not REST

Greenbone is configured through the **Greenbone Management Protocol (GMP)** — a
human-readable, XML request/response protocol spoken over a **raw TLS socket**
(gvmd's classic listener is TLS on **port 9390**). There is no REST API. The core
transport is isolated in [`lib/greenboneApi.ts`](./lib/greenboneApi.ts):

- opens a `node:tls` socket to gvmd,
- sends `<authenticate><credentials><username>…</username><password>…</password></credentials></authenticate>`
  (GMP is stateful on the connection — the first command must authenticate; the
  same socket is then authorised for every following command),
- sends one GMP XML command and reads exactly one XML response,
- a minimal hand-rolled XML builder/parser handles every command below and reads
  the `status` / `status_text` / `id` attributes off the response.

No external XML library is used (`node:tls` + a tiny build/parse). The transport is
a deliberately swappable seam — a unix-socket / SSH-tunnel transport can be added
behind the same `GmpSession` interface. `lib/greenboneApi.ts` owns the transport,
the wire-format primitives (escaping, attribute/child parsing, base64 value
encoding) and the first five entities (targets, port lists, schedules, scan tasks,
plus the scan-config/scanner name lookups scan tasks resolve against); the eleven
newer entities are colocated one-file-per-entity under [`lib/gmp/`](./lib/gmp) —
built on those same primitives — so no single file grows unmanageably large.

### Authentication / credentials

A Greenbone **username + password** (the same credentials as the web UI) for a user
with permission to manage the resources below. Store them as a Veltrix credential on
the **Connections** page (the connection manager's default Password auth). GMP has no
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

## Scan Configs

`create_config` is **clone-only** — GMP has no "define an NVT/family selection
from scratch" command. This type clones a base config (default: the feed's
**Full and fast**, `daba56c8-73ec-11df-a475-002264764cea`) then tunes it via one
`modify_config` call carrying `name`/`comment`/family selection/NVT selection/
scanner preferences, declared as JSON (the same typed-fields-plus-JSON-blob
precedent Cisco Meraki's group policies use for a deeply nested schema).
**FLAG:** drift only compares name/comment — the live `get_configs` response
represents family/NVT selection far more richly than the declared JSON, so
deploy always **re-applies** the declared JSON rather than drift trying (and
risking getting wrong) a deep comparison.

## Scanners

Additional scanner endpoints beyond the feed-provided "OpenVAS Default"
(`create_scanner` / `get_scanners` / `modify_scanner` / `delete_scanner`).
**FLAG:** `create_scanner` **hard-requires an existing GMP credential id** — this
app does not create or store GMP credentials (see [Coverage](#coverage-v040)),
so the operator creates the credential directly in the Greenbone UI first and
this type only references its UUID. `modify_scanner`'s RNC declares
host/port/type as non-optional even on modify, so this app always resends every
field rather than a partial patch. Only scanner **type 2 (OpenVAS classic)** is
confirmed against the GMP 22.5 doc text; types 3 (CVE) and 5 (Greenbone Sensor)
are offered per python-gvm's client enum but flagged **UNVERIFIED** against this
GMP version.

## Alerts

Fire a notification **method** when a **condition** on an **event** is met
(`create_alert` / `get_alerts` / `modify_alert` / `delete_alert`). **Scoped to
secret-free methods only**: Email (plain), HTTP Get, Syslog, Start Task, and SNMP
(its "community" is a plaintext inline alert field, not a vaulted credential).
SCP, SMB, TippingPoint SMS and verinice Connector are **not offered** — gvmd
stores a Credential UUID reference for each of them (confirmed via gvmd's own
credential-in-use check), and this app does not manage GMP credentials.
`test_alert` (a live test-fire) is a runtime action, not config, and is not
exposed.

## Filters

A named, reusable search term scoped to a GMP resource type (`create_filter` /
`get_filters` / `modify_filter` / `delete_filter`). `type` is plain text in the
protocol (not a closed enum) — the canvas offers the best-known resource types.

## Tags

A name/value label attached to a set of resources of one resource type
(`create_tag` / `get_tags` / `modify_tag` / `delete_tag`). **FLAG:** the
resource-attachment shape is genuinely ambiguous between two forms the GMP docs
show — this app uses the `<resources><type/><resource id/>…</resources>` wrapper
(matching python-gvm's tested request builder) with `action="set"` on modify (a
full replace), so a redeploy is idempotent regardless of what was attached
out-of-band. The attached resource id list is **not diffed by drift** (the read
shape is not independently verified here) — it is always re-applied as declared.

## Groups

A named set of existing GMP **usernames** (not ids) — `create_group` /
`get_groups` / `modify_group` / `delete_group`. **FLAG:** the "give every member
full access to each other's entities" flag (`specials/full`) is **create-only**
— `modify_group` has no `specials` field at all, so changing it after creation
needs a delete + recreate; deploy surfaces the mismatch as a note rather than
silently ignoring it (the same pattern Port Lists uses for its immutable
ranges).

## Roles

A named capability set a user/group can hold (`create_role` / `get_roles` /
`modify_role` / `delete_role`) — permissions attach to it only via the separate
**Permissions** config type (GMP 22.x's `create_role`/`modify_role` carry no
permission list of their own). The **7 predefined/protected roles** — Admin,
User, Observer, Guest, Info, Monitor, Super Admin, with UUIDs read directly from
gvmd server source (`manage_sql.h`) — are **never** targeted for
create/modify/delete; a declared name colliding with one is rejected at
validate time.

## Permissions

Grants one capability (a GMP command name, e.g. `get_tasks`, or the special
`Super`) to a subject (user/group/role), optionally scoped to one resource
(`create_permission` / `get_permissions` / `modify_permission` /
`delete_permission`). **A permission has no name field** — `name` is the granted
command, and `(name, subject, resource)` isn't enforced unique by gvmd — so this
type tracks identity by the **canvas item's own stable id** across deploys (the
same pattern `apps/pfsense/config-types/static-routes` uses for a nameless
resource), including deleting a permission whose canvas item was removed.

## Report Formats

**Scoped strictly to cloning + activate/rename/tune-params** of an existing
(usually predefined) format (`create_report_format` via `<copy>` only /
`get_report_formats` / `modify_report_format` / `delete_report_format`).
**Security scope limit:** GMP's *other* create path — replaying a full exported
`get_report_formats_response` — carries a base64 `<file>` element containing the
actual report-generation **script** (XSLT/Python); that path installs executable
code server-side and is **never used** by this app, matching the platform's "no
executables" posture. Leave `reportFormatId` blank + set `cloneFrom` to clone a
new format (its id is then remembered per canvas item); or point `reportFormatId`
at an existing format (predefined, or one this app cloned earlier) to just tune
it. A format the operator pointed at by an existing id is **never deleted**, even
if its canvas item is removed — only a format this app itself cloned is. `active`/
`name`/`summary`/`param` values only tune an **already-installed** format; new
parameters cannot be added. `verify_report_format` (a feed-signature check) is a
runtime action and is not exposed.

## Overrides

A persistent, re-appliable rule that changes the reported **severity** of a
specific NVT's results — a risk-acceptance / false-positive annotation
(`create_override` / `get_overrides` / `modify_override` / `delete_override`).
**No name field** — identity is tracked by the canvas item's own stable id, the
same pattern Permissions uses. `newSeverity` supports the documented specials
(`-1` = False Positive, `0` = Log). **FLAG:** the "active" days-count is a
write-side convenience whose live read-side representation is not independently
verified here to correspond 1:1, so it is always re-applied on deploy rather
than diffed by drift.

## Notes

Structurally identical to Overrides minus the severity fields — a persistent
comment on a specific NVT's results (`create_note` / `get_notes` / `modify_note`
/ `delete_note`). Same no-name-field identity tracking and the same "active"
days-count caveat as Overrides.

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
- Every per-type FLAG called out above (scanner types 3/5, the tag
  resource-attachment shape, `usage_type`'s exact introduction version, whether
  `modify_ticket` would accept `Fix Verified`, the literal wire acceptance of the
  `Super` permission name) is UNVERIFIED against a live 22.5 gvmd and should be
  confirmed before relying on it in automation.

## Coverage (v0.4.0)

Coverage was audited against the GMP 22.5 command reference
(`docs.greenbone.net/API/GMP/gmp-22.5.html`) and python-gvm's request builders
(`gvm/protocols/gmp/requests/v224/`, which GMP 22.5 inherits unchanged), plus
gvmd server source for facts the protocol doc itself doesn't state (predefined
role UUIDs, which alert methods store a Credential reference).

### Managed declarative GMP configuration

| Configuration type | GMP commands |
| --- | --- |
| Scan Targets | `create_target` / `get_targets` / `modify_target` / `delete_target` |
| Port Lists | `create_port_list` / `get_port_lists` / `modify_port_list` / `delete_port_list` |
| Schedules | `create_schedule` / `get_schedules` / `modify_schedule` / `delete_schedule` |
| Scan Tasks | `create_task` / `get_tasks` / `modify_task` / `delete_task` |
| Scan Configs | `create_config` (clone-only) / `get_configs` / `modify_config` / `delete_config` |
| Scanners | `create_scanner` / `get_scanners` / `modify_scanner` / `delete_scanner` |
| Alerts | `create_alert` / `get_alerts` / `modify_alert` / `delete_alert` (secret-free methods only) |
| Filters | `create_filter` / `get_filters` / `modify_filter` / `delete_filter` |
| Tags | `create_tag` / `get_tags` / `modify_tag` / `delete_tag` |
| Groups | `create_group` / `get_groups` / `modify_group` / `delete_group` |
| Roles | `create_role` / `get_roles` / `modify_role` / `delete_role` (custom roles only) |
| Permissions | `create_permission` / `get_permissions` / `modify_permission` / `delete_permission` |
| Report Formats | `create_report_format` (clone-only) / `get_report_formats` / `modify_report_format` / `delete_report_format` |
| Overrides | `create_override` / `get_overrides` / `modify_override` / `delete_override` |
| Notes | `create_note` / `get_notes` / `modify_note` / `delete_note` |

Every type ships the full `validate`/`deploy`/`rollback`/`healthCheck`/
`driftDetect`/`getStatus` handler set. Name-based types (Targets through Roles)
upsert by name, matching this app's original convention; Permissions, Overrides,
Notes and (when cloning) Report Formats have no name field in GMP, so identity
is tracked by the canvas item's own stable id instead (the
`apps/pfsense/config-types/static-routes` pattern) — including reconciling
deletes for a canvas item the operator removes.

### Intentionally excluded

- **Credentials** (`create_credential`/`get_credentials`/`modify_credential`/
  `delete_credential`) — **all 7 GMP credential types** (Username+Password,
  Username+SSH-Key, Client Certificate, SNMP, S/MIME, OpenPGP, Password-only)
  carry secret or sensitive key material with no exception. This app does not
  create, store, or vault GMP credentials; Scanners and secret-backed Alert
  methods instead **reference an existing credential UUID** the operator
  creates directly in the Greenbone UI.
- **Tickets** (`create_ticket`/`get_tickets`/`modify_ticket`/`delete_ticket`) —
  `create_ticket` is permanently bound to one point-in-time scan `result_id`
  and has no name field at all; it models a remediation workflow record, not a
  reusable, re-appliable declarative config object.
- **Report Format raw import** — the `get_report_formats_response`-replay
  creation path installs an executable report-generation script server-side;
  this app only ever uses the `<copy>` clone path (see Report Formats above).
- **Every GMP runtime action** — `start_task`/`stop_task`/`resume_task`,
  `test_alert`, `verify_scanner`, `verify_report_format`, `sync_config`,
  `verify_agent`(n/a), trashcan restore/empty, and similar imperative
  operations fire a real action rather than declare durable desired state, and
  are out of scope for a config-as-code canvas.
- **Read-only GMP data** — `get_reports`, `get_results`, `get_assets`,
  `get_nvts`/`get_cves`/`get_cpes`/feed data, `get_system_reports`,
  `get_aggregates`, and GMP **users** (`create_user`/etc., which carry
  passwords — the same secret-material exclusion as Credentials) are not
  configuration to declare and are outside this app's scope.

Primary references: [GMP 22.5 command reference](https://docs.greenbone.net/API/GMP/gmp-22.5.html),
[python-gvm](https://github.com/greenbone/python-gvm) (`gvm/protocols/gmp/requests/v224/`),
and [gvmd server source](https://github.com/greenbone/gvmd) (`src/manage_sql.h`, `src/manage_sql.c`)
for the predefined-role UUIDs and alert credential field names.

## Roadmap

- **BYOL infrastructure hosting** for the Greenbone stack (gvmd + scanner + feed +
  PostgreSQL) — shipped in 0.3.0.
- Verify the UNVERIFIED flags above (scanner types 3/5, `usage_type`'s exact
  introduction version, `modify_ticket`'s `Fix Verified`, the `Super` permission
  name) against a live gvmd 22.5 instance.

## References

- GMP 22.5 command reference — https://docs.greenbone.net/API/GMP/gmp-22.5.html
- python-gvm (TLSConnection, `Gmp(connection).authenticate`, request builders) —
  https://greenbone.github.io/python-gvm/ · https://github.com/greenbone/python-gvm
- gvmd server source (predefined roles, credential-in-use checks) —
  https://github.com/greenbone/gvmd
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
assembly + response parsing, and `validate.ts`) for all 15 configuration types.

# Qualys (Veltrix app)

Manage **Qualys VMDR / Policy Compliance** configuration as code through the
classic **v2 API**. Authoring happens in the Veltrix Configuration Canvas; every
write goes through the Security-as-Code pipeline (validate → deploy → health
check → drift detect → rollback).

## What it manages

| Configuration type                 | Qualys endpoint                                    | Identity (natural key)  |
| ------------------------------------ | ----------------------------------------------------- | ------------------------- |
| **Qualys Asset Groups**            | `/api/2.0/fo/asset/group/`                         | Title                   |
| **Qualys Asset Tags**              | QPS `/qps/rest/2.0/…/am/tag`                       | Name                    |
| **Qualys Custom Networks**         | `/api/2.0/fo/network/`                             | Name                    |
| **Qualys Search Lists**            | `/api/2.0/fo/qid/search_list/static/`              | Title                   |
| **Qualys Dynamic Search Lists**    | `/api/2.0/fo/qid/search_list/dynamic/`             | Title                   |
| **Qualys VM Option Profiles**      | `/api/2.0/fo/subscription/option_profile/vm/`      | Title                   |
| **Qualys Scan Schedules**          | `/api/2.0/fo/schedule/scan/`                       | Scan title              |
| **Qualys Authentication Records**  | `/api/2.0/fo/auth/<type>/`                         | (Technology, Title)     |
| **Qualys VM Report Templates**     | `/api/2.0/fo/report/template/<scan\|patch\|map>/`  | (Template type, Title)  |
| **Qualys Users**                   | `/msp/user.php`, `/msp/user_list.php`              | Email                   |

Each type reconciles by its natural key: the deploy handler lists the live
objects, matches on the key, then **edits/updates** the matching object or
**adds/creates** a new one. Rollback deletes anything this deployment created and
restores anything it updated, with documented best-effort limits where Qualys
itself doesn't support a full round trip — see [Limitations](#limitations) and
[Coverage](#coverage).

## Authentication

Qualys is a multi-POD SaaS. Each subscription lives on one **platform** whose API
server is a fixed hostname — the component hostname. Find yours under **Help >
About** in the Qualys UI. Examples:

| Platform | API server                          |
| -------- | ----------------------------------- |
| US1      | `qualysapi.qualys.com`              |
| US2      | `qualysapi.qg2.apps.qualys.com`     |
| US3      | `qualysapi.qg3.apps.qualys.com`     |
| EU1      | `qualysapi.qg1.apps.qualys.eu`      |
| IN1      | `qualysapi.qg1.apps.qualys.in`      |

- **Auth:** HTTP Basic (a Qualys account username + password).
- Every classic v2 call additionally sends the **`X-Requested-With`** header
  Qualys requires as a CSRF guard (omitting it returns HTTP 400).
- Requests are form-encoded POSTs; responses are XML.
- Rate / concurrency limits surface as **HTTP 409** with `X-RateLimit-*` /
  `X-Concurrency-Limit-*` response headers.

## Setup

1. **API account** — create a dedicated Qualys service account with **API access**
   enabled and a role scoped to what this app manages.
2. **Credential** — store the account as a Veltrix credential: **username** →
   Qualys username, **password** → Qualys password.
3. **Component** — register a **`qualys-platform`** component whose hostname is
   your platform API server (Help > About) and attach the credential.
4. **Connections** — use the app's Connections page to verify the platform URL +
   credential with a live probe
   (`GET /api/2.0/fo/asset/group/?action=list&truncation_limit=1`).

## Configuration notes

- **Asset Groups** — `title` must be unique and cannot be `All`. `ips` is a
  comma/whitespace-separated list of IPs, ranges (`10.0.0.1-10.0.0.254`) and CIDR
  blocks; it overwrites the group's IP set on each deploy. `network_id` applies
  only to subscriptions with the Network Support feature.
- **Search Lists** — static lists of numeric QIDs. The full QID set is replaced on
  each deploy (`qids`, which the API forbids mixing with add/remove).
- **Scan Schedules** — reference an existing option profile by `option_title` and
  target existing asset groups by `asset_group_titles`. Timing and any extra
  Qualys schedule parameters go in `schedule_json`, a flat JSON object that must
  include an `occurrence` (`daily` | `weekly` | `monthly`), e.g.
  `{"occurrence":"weekly","frequency_weeks":1,"weekdays":"1","start_date":"08/01/2026","start_hour":2,"start_minute":0,"time_zone_code":"US-CA"}`.
- **Authentication Records** — pick a **Technology** (Unix/Cisco/Checkpoint,
  Windows, Oracle, SNMP, VMware, MS SQL, MySQL, PostgreSQL, IBM DB2, Docker,
  HTTP, Network Device SSH, MongoDB, Tomcat, Apache, IIS, IBM WebSphere,
  Sybase, Palo Alto Firewall, MS Exchange, Oracle Listener/WebLogic — 22
  total). Titles are unique **within** a technology, not globally.
  `credentials_json` is a flat JSON object of that technology's login
  parameters (at minimum a username, plus a password or `login_type: "vault"`
  with the matching vault parameters) — it is **write-only**: sent on every
  deploy, never read back, diffed or logged.
- **Custom Networks** — just a `name`. Requires the Network Support feature to
  be enabled for the subscription.
- **VM Report Templates** — pick a **Template Type** (Scan, Patch or Map).
  `settings_xml` is everything besides title/owner, as the exact
  `<SECTION><INFO key="param">value</INFO>…</SECTION>` XML the Report Template
  Export API returns — the easiest way to author it is to export an existing
  template and paste in everything between `</TITLE>` and the closing
  template tag. Leave it blank to accept Qualys' defaults for every setting.
- **Users** — Qualys generates the account `login` itself; this app tracks a
  user by **email** instead. `business_unit` must already exist (business
  units are created in the Qualys UI only) and `user_role` /
  `send_email` only take effect when the user is first created — Qualys does
  not allow changing a user's role via this API. `asset_groups` is rejected by
  Qualys for the Manager/Unit Manager roles.

## Limitations

- Write-only secrets (the credential password, and every authentication
  record's `credentials_json`) are never read back, diffed, or stored in
  rollback data / artifacts / logs.
- **Scan schedule rollback** is best-effort: the classic list API does not return
  a schedule's full recurrence in a re-submittable form, so an *updated* schedule
  is restored only for its title / active flag / option profile — created
  schedules roll back cleanly (deleted). Drift detection for schedules compares
  the fields the list API exposes (active flag, option profile).
- **Custom network rollback** cannot delete a created network — Qualys has no
  delete-network API (only Create/Update/List/Assign-Scanner-Appliance exist).
  A created network is renamed back on rollback... except there is nothing to
  rename it back FROM (it did not exist before), so it simply remains; this is
  reported in the rollback result, not silently swallowed.
- **User rollback** cannot delete a created user — Qualys has no delete-user
  API (only Activate/Deactivate). Rollback best-effort deactivates a created
  user instead, which fails for an account still in "Pending Activation"
  (the default `send_email=1` flow) until that user first logs in. An updated
  user is restored only for first/last name and job title — the only fields
  this app can read back from the account list.
- **Report template rollback** can delete a created template cleanly, but
  cannot restore an updated template's prior settings — this app does not
  retain the settings XML that was live before a deploy, only what was
  declared; an updated template keeps its newly deployed settings on
  rollback. See [Coverage](#coverage) for why PCI Scan Template isn't
  supported.
- The app writes only through the Qualys API; it registers no platform-side
  database tables or background jobs.

## Coverage

Sourced against the *Qualys API (VM and PA) User Guide* and the *Asset
Management & Tagging API User Guide*.

**Managed (10 configuration types):**

- Asset Groups, Asset Tags, Custom Networks, Search Lists (static + dynamic),
  VM Option Profiles, Scan Schedules, Authentication Records, VM Report
  Templates (Scan/Patch/Map), Users — see [What it manages](#what-it-manages)
  for each type's endpoint.

**Intentionally excluded:**

| Surface | Why |
| --- | --- |
| PCI Scan Template | Has full create/update/delete/export on its own endpoint (`/api/2.0/fo/report/template/pciscan/`), but its `<TEMPLATE_TYPE>` value in the shared `/msp/report_template_list.php` reconciliation list is not documented distinctly from Scan/Compliance — reconciling it by title risks a cross-type collision, so it's excluded rather than shipped with an unverified match. |
| Policy Compliance policies | (Carried over from 1.2.0.) Creating a policy requires importing a full policy XML document, and deleting one is only available through the incompatible Bearer-token PCAS v3 API — no compatible create+delete pair exists for this app's HTTP Basic client. |
| Cloud Agent Configuration Profiles | Its API (`<qualys_base_url>/caui/v1/config-profiles`) requires Bearer-token OAuth, not HTTP Basic — a different credential model from every other surface this app manages. |
| Host assets | The Asset Management QPS API can create host assets, but they are scan-populated inventory records Qualys' own scanning/Cloud Agent continuously overwrites — modeling them as desired state would produce perpetual false-positive drift. Meant for CMDB import/bootstrap, not steady-state config. |
| Business units | No create/update/delete API exists anywhere in the Qualys API (VM/PC) User Guide — the Add/Edit User API states outright that "business units may be created using the Qualys user interface only." |
| Distribution groups | Same as business units — referenced only as a report-notification parameter (`recipient_group_id`), never as a manageable resource with its own endpoint. |
| One-shot scan/report launches, findings, KnowledgeBase | Read-only or execute-once actions, not declarative config — nothing to reconcile against on a second deploy. |
| Scanner appliances (physical/virtual/containerized) | Represent physical/registered infrastructure objects (an appliance you install and pair), not a scan/asset policy — out of scope for this app's config-as-code surface. |

## Development

```
cd apps/qualys
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs qualys           # run the validate tests
node ../../scripts/validate-app.mjs apps/qualys    # (from repo root) manifest + bundle checks
```

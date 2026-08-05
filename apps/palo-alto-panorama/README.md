# Palo Alto Panorama (Veltrix app)

Manage Palo Alto Networks **Panorama / PAN-OS** configuration as code through the
**PAN-OS REST API**, with commits handled via the **XML API**. Authoring happens in
the Veltrix Configuration Canvas; every write goes through the Security-as-Code
pipeline (validate → deploy → health check → drift → rollback).

## What it manages

23 configuration types, grouped the same way the app's sidebar groups them. See
**## Coverage** below for the full, audited breakdown (REST endpoint, notes, and
what was deliberately left out and why).

| Group | Configuration types |
| --- | --- |
| *(ungrouped — objects & policies)* | Tags, Address Objects, Service Objects, Address Groups, Service Groups, Application Groups, Security Rules, NAT Rules, Security Profile Groups, Antivirus Profiles, Anti-Spyware Profiles, URL Filtering Profiles, WildFire Analysis Profiles |
| Objects | Schedules, Custom URL Categories, External Dynamic Lists |
| Security Profiles | Vulnerability Protection Profiles, File Blocking Profiles, Data Filtering Profiles |
| Policies | Decryption Rules, Policy-Based Forwarding Rules, Authentication Rules |
| Logging | Log Forwarding Profiles |

Deploy order matters: **tags/schedules/custom-URL-categories/EDLs → address &
service objects → groups → security profiles → security profile groups → log
forwarding profiles → security/NAT/decryption/PBF/authentication rules** (rules
reference everything else). All rule types are created in the device-group
**pre** rulebase.

## Authentication

The credential is a **pre-generated PAN-OS API key** stored in the credential's
**API token** field. The app sends it as the `X-PAN-KEY` header on every REST
call. No username is required. Generate a key with:

```
curl -k -X POST 'https://<panorama>/api/?type=keygen' -d 'user=<u>&password=<p>'
```

Register a **`panorama`** component whose hostname is the Panorama management host
(e.g. `panorama.example.com`). HTTPS is always used.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `device_group` | `shared` | Target device group; `shared` uses the shared location, any other value uses `location=device-group` |
| `rest_api_version` | `v11.0` | REST API version segment. **Note:** this does not always equal the PAN-OS release — PAN-OS 11.1 serves `/restapi/v11.0` |
| `auto_commit` | `false` | When on, deploy/rollback commit the candidate to Panorama and poll the job |
| `verify_tls` | `true` | Informational only — see TLS note below |
| `request_timeout_seconds` | `30` | Per-request timeout |

## Deploy, commit & rollback model

* Every REST `POST/PUT/DELETE` writes only the **candidate** configuration.
* Deploy upserts each object (list → PUT existing / POST new), tracking which
  objects it **created** for rollback.
* When `auto_commit` is on, deploy commits the candidate to Panorama via the XML
  API (`type=commit`) and polls the returned job to completion (bounded ~60s).
  Committing to Panorama does **not** by itself push to managed firewalls — an
  operator still runs a device-group push (commit-all) to activate on devices.
  **Commit is never modeled as its own configuration type** — it is a one-shot
  activation action inherent to every deploy/rollback, not a piece of
  declarative, round-trippable state.
* **Rollback** deletes only the objects this deploy created (tolerating 404),
  then commits when `auto_commit` is on. It never touches objects it did not
  create and never performs a candidate-revert.

## TLS

Panorama management certificates are commonly self-signed. Handlers run
in-process and cannot disable TLS verification, so the **platform host must trust
the Panorama certificate**. The `verify_tls` setting is informational.

## Coverage

Audited 2026-08-05 against the **PAN-OS REST API** (`/restapi/v10+`, "Objects" /
"Policies" categories), cross-referenced with the
[pypanrestv2](https://github.com/mrzepa/pypanrestv2) Python client (whose class
names map 1:1 to REST resource segments — verified directly against this app's
own already-deployed `SecurityPreRules` / `NATPreRules` paths) and the
[terraform-provider-panos](https://github.com/PaloAltoNetworks/terraform-provider-panos)
resource schemas (ground truth for field shapes). 23 configuration types total.

### Managed

| Configuration type | REST resource | Notes |
| --- | --- | --- |
| Tags | `/Objects/Tags` | Color + comments |
| Address Objects | `/Objects/Addresses` | ip-netmask, ip-range or fqdn |
| Service Objects | `/Objects/Services` | tcp/udp ports |
| Address Groups | `/Objects/AddressGroups` | Static or dynamic |
| Service Groups | `/Objects/ServiceGroups` | Member services |
| Application Groups | `/Objects/ApplicationGroups` | Member App-IDs / filters / nested groups |
| **Schedules** *(new)* | `/Objects/Schedules` | Non-recurring date ranges, daily, or weekly per-day time ranges |
| **Custom URL Categories** *(new)* | `/Objects/CustomURLCategories` | "URL List" (raw URLs/domains) or "Category Match" (bundle of existing categories) |
| **External Dynamic Lists** *(new)* | `/Objects/ExternalDynamicLists` | ip/domain/url source types, recurring refresh, exception list, certificate profile (see Dropped: EDL authentication) |
| Security Profile Groups | `/Objects/SecurityProfileGroups` | Bundles one profile of each of the 7 types below |
| Antivirus Profiles | `/Objects/AntivirusSecurityProfiles` | Virus/WildFire actions applied uniformly across protocol decoders |
| Anti-Spyware Profiles | `/Objects/AntiSpywareSecurityProfiles` | Single rule: severity/action/packet-capture/category/threat-name |
| **Vulnerability Protection Profiles** *(new)* | `/Objects/VulnerabilityProtectionSecurityProfiles` | Single rule: severity/CVE/category/threat-name/host/action/packet-capture — closes the profile referenced by Security Profile Groups since 1.2.0 |
| URL Filtering Profiles | `/Objects/URLFilteringSecurityProfiles` | Categories bucketed by action |
| **File Blocking Profiles** *(new)* | `/Objects/FileBlockingSecurityProfiles` | Single rule: applications/file-types/direction/action — closes the profile referenced by Security Profile Groups since 1.2.0 |
| WildFire Analysis Profiles | `/Objects/WildFireAnalysisSecurityProfiles` | Single rule: applications/file-types/direction/analysis location |
| **Data Filtering Profiles** *(new)* | `/Objects/DataFilteringSecurityProfiles` | Single rule: referenced data-pattern object, direction, alert/block thresholds — closes the profile referenced by Security Profile Groups since 1.2.0 |
| **Log Forwarding Profiles** *(new)* | `/Objects/LogForwardingProfiles` | Single match-list entry: log type, filter, Panorama/syslog/email/HTTP/SNMP-trap destinations — closes the profile referenced by Security Rules' `log_setting` since day one |
| Security Rules | `/Policies/SecurityPreRules` | Zones/source/dest/app/service/action/profiles |
| NAT Rules | `/Policies/NATPreRules` | IPv4 source/destination translation |
| **Decryption Rules** *(new)* | `/Policies/DecryptionPreRules` | SSL forward proxy, SSL inbound inspection (with certificates) or SSH proxy |
| **Policy-Based Forwarding Rules** *(new)* | `/Policies/PolicyBasedForwardingPreRules` | forward (egress interface, next hop, path monitor) / discard / no-pbf / forward-to-vsys, with symmetric return |
| **Authentication Rules** *(new)* | `/Policies/AuthenticationPreRules` | Captive Portal / MFA enforcement matched by zone, address, user, category |

Every managed type follows the same model: validate → deploy (idempotent upsert
by name, tracked for rollback) → rollback (delete-what-we-created) → health
check (declared objects present) → drift detect (live vs. declared, with
best-effort who/when attribution from the config audit log) → status.

### Considered and dropped (honest gaps)

| Candidate | Why it's dropped |
| --- | --- |
| **Commit as a configuration type** | One-shot activation action (`type=commit`), not declarative round-trippable state — already the app's model (see Deploy, commit & rollback model above); modeling it as a config type would give it a fake "current state" to drift-detect against |
| **Zones** (`/Network/Zones`) | Network-category, scoped by **vsys/template** — not `location=shared\|device-group` like every type this app manages. Adding it would require a second, incompatible location/scoping model (template name + vsys) this app's settings don't carry |
| **Templates & Template Stacks** (`/Panorama/Templates`, `/Panorama/TemplateStacks`) | Panorama-hierarchy container objects that sit *above* this app's own `device_group` setting (which names a device group that must already exist) — authoring the containers a deploy targets is a scope inversion, and they use no `location=shared\|device-group` param at all |
| **Device Groups** (`/Panorama/DeviceGroups`) | Same reasoning as Templates — this app's `device_group` setting already names the pre-existing target; it does not create its own scope |
| **LDAP / RADIUS / Authentication Profiles** (`/Device/LDAPServerProfiles`, `/Device/RADIUSServerProfiles`, `/Device/AuthenticationProfiles`) | Device-category, template/vsys-scoped (not device-group/shared); **and** LDAP bind password / RADIUS shared secret are secret material PAN-OS masks on every read, so they cannot be diffed or round-tripped. Authentication Rules reference an Authentication Enforcement object (which points at one of these) **by name**, the same free-text-reference precedent Security Rules already uses for `profile_group` / `log_setting` |
| **HIP Objects / Profiles** (`/Objects/HIPObjects`, `/Objects/HIPProfiles`) | Objects-scoped (would technically fit this app's location model), but this app has no consumer for them — GlobalProtect (below) is out of scope and Security Rules do not model `source-hip`/`destination-hip` matching, so authoring HIP objects here would be orphaned config with nothing to attach them to |
| **GlobalProtect Gateway / Portal** (`/Network/GlobalProtectGateways`, `/Network/GlobalProtectPortals`) | Network-category, template-scoped, **and** requires an SSL/TLS service profile bound to a certificate — scoping mismatch plus certificate/secret material |
| **QoS Rules** (`/Policies/QoSPreRules`) | Deferred, not ruled out: a QoS policy rule only does something once egress-interface bandwidth/QoS profiles exist, which live in the same Network-category, template-scoped surface as Zones above — the rule *type* fits this app's model, but pairing it with the interface-side config it depends on does not yet |
| EDL authenticated source URLs (`type.*.auth.username/password`) | PAN-OS masks the password on every `GET` — it cannot be diffed or round-tripped. External Dynamic Lists are managed with an unauthenticated source URL |
| Certificate material anywhere (Decryption Rules' `certificates`, EDL's `certificate_profile`) | Only the **name** of an already-installed certificate/profile is referenced — the certificate/key itself is never authored, read, or stored by this app |
| Multi-rule security profiles, per-decoder overrides, threat exceptions, ML-engine settings | Every "single-rule" profile type (Anti-Spyware, WildFire, Vulnerability, File Blocking, Data Filtering) models the common one-rule-per-profile case, matching the precedent set in 1.2.0 |
| Log Forwarding Profiles' tag/integration actions, multiple match-list entries per profile | Advanced/niche nested schema; one match-list entry per profile covers the common single-log-type case — a profile needing multiple log types today needs one canvas item per log type |
| PBF interface-based `from` match, per-device rule targeting, administrative tags, active/active HA device binding | Advanced/niche fields not modeled on *any* rule type in this app (Security, NAT, Decryption, PBF, Authentication) — consistent scope across the whole rule family |
| Rule **ordering** within any rulebase | Not managed; rules are upserted by name, not by position |
| Post-rulebase (any rule type) | Only the device-group **pre** rulebase is exposed |

## Scope & limitations

* Objects that pre-existed and were updated in place are **not** restored by
  rollback (rollback only deletes what it created). Prefer letting this app own
  the objects it manages.
* See **## Coverage** above for the full, sourced list of what is deliberately
  out of scope and why.

## Development

```
cd apps/palo-alto-panorama
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs palo-alto-panorama  # run tests
node ../../scripts/validate-app.mjs apps/palo-alto-panorama  # validate
```

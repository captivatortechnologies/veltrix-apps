# 🧅 Security Onion

Manage [Security Onion](https://securityonion.net) — the open-source Network
Security Monitoring / SIEM platform — as code on the Veltrix Security-as-Code
platform. Author grid configuration in the Configuration Canvas and drive it
through the pipeline (validate → deploy → rollback → health-check → drift-detect
→ status), with BYOL infrastructure provisioning.

## How it's managed

Security Onion has no single configuration API — the **manager** owns the grid via
**Salt**. This app applies configuration two ways:

- **Salt / `so-*` CLI over managed ZTNA** (`ctx.remote.command`) — Suricata rule
  state, firewall/analyst access, SOC users, Zeek. The app declares its command
  vocabulary in `manifest.yaml` (`remoteCommands`); the platform validates every
  parameter and shell-quotes it. Requires managed connectivity to the manager.
- **HTTPS REST** — the SOC console / Kibana Detection Engine and Data Views
  APIs (443), and Elasticsearch (9200) for index lifecycle and index
  templates. These are generic Kibana/Elasticsearch REST APIs reachable at the
  grid's own ports, not Security Onion-invented endpoints. Self-signed
  certificates are tolerated.

See [`DATAFLOW.md`](./DATAFLOW.md) for how each operation routes to completion.

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Suricata Rules** | `so-rule` + Salt highstate | ✅ v0.1.0 |
| **Firewall / Analyst Access** | `so-firewall` + Salt highstate | ✅ v0.2.0 |
| **SOC Users** | `so-user` + Salt highstate | ✅ v0.2.0 |
| **Zeek Configuration** | Salt (declared command) | ✅ v0.2.0 |
| **Detection Engine Rules** | Kibana Detection Engine (REST, 443) | ✅ v0.2.0 |
| **Elasticsearch ILM Policies** | Elasticsearch (REST, 9200) | ✅ v0.2.0 |
| **Elasticsearch Index Templates** | Elasticsearch (REST, 9200) | ✅ v0.6.0 |
| **Kibana Data Views** | Kibana Data Views (REST, 443) | ✅ v0.6.0 |

See [Coverage](#coverage) below for what each type manages, what was
deliberately excluded, and why.

## BYOL infrastructure

`infra/spec.ts` declares the grid (manager / manager-search / search / sensor /
forward / fleet / receiver / heavy / idh / standalone) as a declarative
`InfraSpec` composed from the generic OpenTofu modules — no tool-specific HCL. The
generic provisioning worker runs `infra/bringup/so-setup.mjs` (Salt `so-setup`)
after `tofu apply`, gating readiness on the Elastic cluster and SOC.

## Coverage

Security Onion has no single configuration API by design — the grid is a
Salt-managed appliance, and most of what an operator tunes day-to-day (NIDS
rule tuning, ruleset sources, Elastic Fleet, most of Administration →
Configuration) lives behind the SOC web UI's own settings tree, not a public
REST surface. This section is the full, honest accounting: what this app
manages, the boundary that keeps most of the rest out of scope, and the
handful of things researched and rejected with a citation for each.

Researched against [docs.securityonion.net/en/2.4](https://docs.securityonion.net/en/2.4/)
(the version this app targets), the
[Security-Onion-Solutions/securityonion](https://github.com/Security-Onion-Solutions/securityonion)
source, and — for the two REST APIs this app calls that are Elastic's own
rather than Security Onion's — Elastic's official Kibana/Elasticsearch API
reference.

### Managed (8 config types)

| Config type | Surface | Source |
| --- | --- | --- |
| `suricata-rules` | `so-rule` + Salt highstate | `so-rule` — declared in `remoteCommands` |
| `firewall-access` | `so-firewall` + Salt highstate | `so-firewall` — declared in `remoteCommands` |
| `soc-users` | `so-user` + Salt highstate (enable/disable existing users only) | [`so-user`](https://docs.securityonion.net/en/2.4/so-user.html) — CLI documents only `list` and `password`; enable/disable is this app's own declared command |
| `zeek-config` | Salt (declared command, representative mapping) | Salt-managed; verify log-type/analyzer names against your grid |
| `detections` | Kibana Detection Engine REST (443) | Kibana's own [Detection rules API](https://www.elastic.co/guide/en/security/current/rule-api-overview.html) — SO ships Kibana with the Security app enabled |
| `elastic-ilm` | Elasticsearch ILM REST (9200) | Elasticsearch's [Index Lifecycle Management API](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html) |
| `elastic-index-templates` | Elasticsearch REST (9200) | Elasticsearch's [Create/update index template](https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-put-template.html) and [Get index template](https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-get-template.html) APIs |
| `kibana-data-views` | Kibana Data Views REST (443) | Kibana's [Data Views API](https://www.elastic.co/guide/en/kibana/current/data-views-api-create.html) (create/get/update/delete) |

`elastic-ilm` and `elastic-index-templates` are a deliberate pair: an index
template's `index.lifecycle.name` is what attaches a custom ILM policy to new
indices, so a custom retention policy is only useful once a matching template
exists. Both call Elasticsearch's REST API directly at 9200 — the same generic
Elastic Stack surface `detections` and `kibana-data-views` already reach on
Kibana at 443 — rather than Security Onion's own Salt-pillar-backed
`Administration → Configuration → elasticsearch` settings tree (see the
boundary below). They manage **custom** templates/policies for third-party or
custom log sources, not Security Onion's own built-in ones.

### The Salt-pillar / Connect API boundary

Nearly everything else an operator can change in the SOC UI — NIDS tuning
overrides, ruleset sources, Elasticsearch node roles/heap/watermark/shard
sizing, Elastic Fleet settings — is stored as Salt pillar and edited through
**Administration → Configuration**, a generic settings-tree editor, not a
per-feature REST resource. Security Onion documents exactly one programmatic
way to reach that tree and the rest of the SOC backend: the
[**Connect API**](https://docs.securityonion.net/en/3/main/connect-api/so-api-reference.html)
(`/connect/...`, OAuth2 client-credentials) — and it is filed under
**"Security Onion Pro"** in the docs, requiring a Pro license key and enabling
"Hydra" before it answers at all. This app manages the open-source grid
(Apache-2.0, no license key), so building a config type against `/connect/...`
would deploy fine in development and then fail for every install that hasn't
bought Pro — the opposite of the "bounded surface, not silently dropped"
standard this Coverage section holds itself to. Every item below that cites
this boundary was excluded for that reason, not because the feature isn't
real or isn't valuable.

### Excluded by design (not a gap — a boundary)

- **NIDS Tuning Overrides** (threshold / suppress / modify) and **Sigma custom
  filters**. This is genuinely the most-requested tuning surface in Security
  Onion's own docs — [`nids.html#tuning-overrides`](https://docs.securityonion.net/en/2.4/nids.html#tuning-overrides)
  gives the exact `threshold.conf` semantics for all three override types. It
  is created only via the Detections UI's TUNING tab; the only documented REST
  path is the Pro Connect API's `PUT /connect/detection/override` (and the
  parent `POST`/`PUT /connect/detection/`). Connect-API-gated — see above.
- **NIDS Ruleset Sources** (enabling ET Pro, adding a custom/local ruleset,
  proxy settings). Fully declarative and exactly the shape this app's other
  types use (`Administration → Configuration → soc → config → server →
  modules → suricataengine → rulesetSources`,
  [`nids.html#configuring-rulesets`](https://docs.securityonion.net/en/2.4/nids.html#configuring-rulesets))
  — but it's a Salt-pillar setting behind `Administration → Configuration`,
  reachable programmatically only via the Connect API's `/connect/config/`.
  Connect-API-gated.
- **SOC User creation, passwords, and role assignment.** `so-user`'s own docs
  ([`so-user.html`](https://docs.securityonion.net/en/2.4/so-user.html)) list
  only `list` and `password` as CLI operations and say user management
  "should normally be done via Administration" (the SOC UI); creating a user
  with a role is interactive there. The Connect API's `POST /connect/users`
  and `POST /connect/users/{id}/role/{role}` are the only documented
  programmatic path. Connect-API-gated — `soc-users` (v0.2.0) already covers
  the CLI-reachable slice (enable/disable an existing user).
- **Elastic Fleet Agent Policies / Elastic Defend endpoint visibility.**
  Security Onion's own docs explicitly discourage automated changes here:
  "We do not recommend removing policy settings for Security Onion grid node
  agents" and, for the Settings tab (Fleet server hosts, outputs), "We do NOT
  recommend changing these settings, as they are managed by Security Onion."
  ([`elastic-fleet.html`](https://docs.securityonion.net/en/2.4/elastic-fleet.html)).
  The endpoint-visibility integrations that ARE meant to be tuned (Elastic
  Defend's per-OS event-collection toggles) live in each package policy's
  nested, Elastic-Agent-version-coupled config schema — the docs themselves
  warn that upgrading past the bundled Elastic Stack version can break things.
  Too deep and too version-fragile to model with the same confidence as the
  types above.
- **Third-Party Integration Index Templates.** Genuinely similar to
  `elastic-index-templates`, but Security Onion's own docs route it through
  the pillar-backed config tree first — a `managed_integrations` toggle at
  `Advanced Settings → Configuration → manager → managed_integrations` must be
  set before the template is even eligible for management
  ([`third-party-integrations.html#managing-third-party-integration-index-templates`](https://docs.securityonion.net/en/2.4/third-party-integrations.html#managing-third-party-integration-index-templates)).
  Connect-API-gated for the toggle itself.
- **Elasticsearch node roles, heap size, disk watermark, field limits, shard
  sizing, size-based retention (`retention_pct`).** All Salt-pillar settings
  under `Administration → Configuration → elasticsearch`
  ([`elasticsearch.html`](https://docs.securityonion.net/en/2.4/elasticsearch.html)),
  which the docs themselves flag as advanced ("you should be careful to avoid
  disruption to your cluster"). Connect-API-gated, and higher blast-radius
  than a config-as-code canvas is the right place for.
- **Kibana Saved Objects (dashboards, visualizations, searches).** A real,
  non-SO-specific Kibana REST API (`/api/saved_objects`), but each object's
  schema is deep, versioned, and reference-graph-shaped (a dashboard embeds
  panel references to visualizations, which embed references to data views).
  `kibana-data-views` is the bounded, stable subset of that same object model
  this app took instead.
- **Cases, Alerts, Playbook.** Runtime/investigative workflow (create a case,
  acknowledge an alert, answer a Playbook question), not desired-state
  configuration — and, per the API reference above, only reachable
  programmatically via the Connect API regardless.
- **Grid node membership / topology.** Already the BYOL infrastructure layer's
  job (`infra/spec.ts` + the BYOL console), not a configuration-type concern.
- **`so-elastic-auth-password-reset`, `so-monitor-add`.** One-shot/interactive
  operations (reset a password now; walk through adding a monitor interface),
  not declarative state a canvas item represents.

### Not yet built — legitimate follow-up, not infeasible

- **Elasticsearch Component Templates** (`_component_template`) — the reusable
  building blocks `composed_of` on an index template references. Same API
  family, same REST surface as `elastic-index-templates` (which already
  accepts a `composedOf` list of existing component template names); left out
  of this wave for scope discipline, not because it's uncertain.
- Everything filed as "Connect-API-gated" above is real, documented (schema
  included, e.g. the Override object's exact fields), and buildable the moment
  two things are both true: the platform's credential model supports an
  OAuth2 client-credentials exchange (this app's other REST types use
  Basic/Bearer), and the operator has a Security Onion Pro license with Hydra
  enabled. Neither is assumed by this app today.

## Notes

Security Onion 2.4 command paths (`/usr/sbin/so-*`, `salt-call`) follow the
documented conventions; verify against your grid. The managed-ZTNA remote path is
gated by the platform's `REMOTE_EXEC_ENABLED` flag.

Apache-2.0.

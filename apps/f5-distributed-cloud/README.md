# F5 Distributed Cloud (XC)

Manage [F5 Distributed Cloud](https://www.f5.com/cloud) (XC) — F5's multi-cloud networking and
security SaaS — configuration as code through its **public config API**. Author configurations in
the platform's Configuration Canvas and deploy them through the Security-as-Code pipeline —
validate, deploy, health check, drift detection and rollback are handled per configuration type.

## Product choice: F5 Distributed Cloud (XC) vs. BIG-IP iControl REST

F5 exposes two very different config surfaces: **BIG-IP** (on-box iControl REST,
`/mgmt/tm/...` — per-appliance virtual servers/pools/iRules/ASM policies) and **F5 Distributed
Cloud** (multi-tenant SaaS, `/api/config/namespaces/{namespace}/...`). This app targets **F5
Distributed Cloud**, because:

- **Connection model fit.** The platform's per-tenant connection model (one credential + one
  endpoint per connection) maps naturally onto F5 XC's tenant + namespace + API Token model — the
  same shape as this catalog's other SaaS security platforms (Okta, PingOne, Cloudflare). BIG-IP is
  a per-appliance device (basic-auth or token to a specific management IP), which is a materially
  different connectivity model already well covered in this catalog by device-based network apps
  (FortiManager, Palo Alto Panorama, Check Point).
- **No device/HA provisioning.** F5 XC's config objects are pure declarative REST resources with
  no on-box bring-up, clustering, or license-activation step — the same "just an API" shape as this
  app's sibling apps.
- **Single auth model.** One API Token credential authenticates every object type; BIG-IP typically
  needs per-device basic-auth or a token-exchange flow per appliance in a cluster.

## Credentials

The app authenticates with an **F5 XC API Token** — a single bearer secret:

1. In the F5 XC Console, go to **Administration → Personal Management → Credentials → Add
   Credentials**, and choose API Credential Type **API Token**.
2. Grant the token's owning user a role covering the object types this app manages (e.g. a
   namespace-scoped admin role, or F5's built-in `ves-io-admin-role`).
3. Copy the generated **API Token** — it is shown once.

Store it as a Veltrix credential:

| Veltrix credential field | F5 XC value |
| --- | --- |
| API token | The API Token value |

An API Token is a single bearer secret (no separate client id) — the app sends it as
`Authorization: APIToken <token>` on every request, confirmed verbatim against F5's own generated
Terraform provider docs
([`docs/resources/volterra_api_credential.md`](https://github.com/volterraedge/terraform-provider-volterra/blob/master/docs/resources/volterra_api_credential.md))
and <https://docs.cloud.f5.com/docs/api/api-credential>.

Register an **`f5xc-namespace`** component whose hostname is your tenant's **Console hostname**
(e.g. `acmecorp.console.ves.volterra.io`), attach the credential, and set the app's **F5 XC
Namespace** setting to the namespace this connection manages (defaults to `default`) — this app
manages exactly one namespace per connection, the same "one target scope per connection"
convention `ping-identity`/`okta-identity` use for environment/org.

On every request the app calls `https://<tenant>.console.ves.volterra.io/api/config/namespaces/
<namespace>/<object>[/​<name>]` — base URL confirmed from the provider's own README
(`url = "https://<tenant_name>.console.ves.volterra.io/api"`).

## What it manages

| Configuration type | F5 XC object(s) | API |
| --- | --- | --- |
| Health Checks | HTTP/TCP/UDP-ICMP probes | `/healthchecks` |
| Origin Pools | Backend server pools, LB algorithm, health check attachment, TLS-to-origin | `/origin_pools` |
| App Firewalls | WAF policies — enforcement mode, response codes, blocking page, bot protection | `/app_firewalls` |
| Service Policies | L7 allow/deny rules by ASN/country/IP prefix, or a custom rule list | `/service_policys` |
| Malicious User Mitigation | Per-threat-level (low/medium/high) mitigation actions | `/malicious_user_mitigations` |
| Network Policies | L3/L4 ingress/egress ACLs scoped to a set of endpoints | `/network_policys` |
| TCP Load Balancers | Listener, origin pool(s), TLS mode, advertise mode, service policy attachment | `/tcp_loadbalancers` |
| HTTP Load Balancers | Domains, TLS mode, default route pools + routes, WAF/bot-defense/rate-limit/CORS attachment | `/http_loadbalancers` |

Every object is identified by **name** within its namespace (there is no separate numeric id) —
deploy `GET`s by name (404 means absent), then `PUT`s (update in place, capturing the prior body for
rollback) or `POST`s (create). Two of these objects have an **irregular plural** in their REST
path — `service_policys` and `network_policys` (not `...policies`) — confirmed directly from F5's
own generated grpc-gateway route literals (see References) rather than assumed from English
pluralization.

Several deeply-nested pieces (Origin Pool `origin_servers`, HTTP Load Balancer `routes` and
`default_route_pools`, Service Policy `rule_list`, Network Policy `ingress_rules`/`egress_rules`)
are authored as a single JSON field rather than fully decomposed canvas controls — the same
convention `ping-identity`/`okta-identity` use for deeply nested policy rule trees — because their
shape varies by discriminated union and F5's own documentation expresses them the same way. Every
JSON field's exact wire shape (with an example) is documented in that field's help text in
`canvas.yaml`.

## Coverage

This first release targets the **8 highest-value, genuinely declarative and round-trippable**
surfaces of the F5 XC public config API — traffic delivery (HTTP/TCP load balancers, origin
pools, health checks) and traffic security (WAF, service policies, malicious user mitigation,
network policies).

### Intentionally excluded (this release)

| Surface | API | Why excluded |
| --- | --- | --- |
| Bot Defense (Standard/Advanced) | `http_loadbalancer.bot_defense` / `.bot_defense_advanced` | Both **require** a nested Bot Defense `policy` object and a `regional_endpoint` selection — a substantial, separately-licensed sub-system this app cannot verify the exact shape/enum of from static docs alone. `disable_bot_defense` is the only bot-defense state this app writes. |
| Rate Limiter / Rate Limiter Policy (standalone) | `/rate_limiters`, `/rate_limiter_policys` | A standalone reusable rate limiter is mainly useful paired with a Rate Limiter Policy's rich per-path/ASN/country matcher tree (comparable in depth to Service Policies) — deferred as its own pass. HTTP Load Balancers already expose genuine declarative rate limiting via their own **inline** `rate_limit.rate_limiter` (threshold + unit), which this app fully supports. |
| Customer-uploaded TLS certificates | `http_loadbalancer.https` / `tcp_loadbalancer.tls_tcp` / `origin_pool` mTLS client certs | Certificate/private-key material is treated as write-only/out-of-scope everywhere in this app, matching the treatment of secret material in every other app in this catalog. F5-managed certificates (`https_auto_cert` / `tls_tcp_auto_cert`) are fully supported instead. |
| Forward Proxy Policies | `/forward_proxy_policys` | A narrower egress/outbound-proxy use case with its own matcher tree comparable in shape to Network/Service Policies — deferred to keep this release focused on inbound app delivery + security, this catalog's dominant theme. |
| Alert Receivers / Alert Policies | `/alert_receivers`, `/alert_policys` | Notification-channel configuration (PagerDuty routing key, Slack/webhook URL) carries secret-adjacent material and is an ops-notification surface, not traffic/security config — the same reasoning `ping-identity` applied to deferring notification templates. |
| API Definition / Discovery / Testing, GraphQL rules, Client-Side Defense, Malware Protection, Data Guard, Sensitive Data Disclosure, DDoS auto-mitigation rules | `http_loadbalancer.*` | Each is its own analysis/detection sub-system (live API-schema discovery, JavaScript injection, ML-based classification) with a nested config shape this app does not model — out of scope for a first release focused on traffic delivery + core security policy. |
| Custom WAF detection tuning (per-signature/per-violation) | `app_firewall.detection_settings.violations_view` | This field is a **required** list once `detection_settings` is chosen, sourced from F5's live, version-specific violation catalog — not a static enum this app can validate offline. This app always uses F5's `default_detection_settings` (all attack types, threat campaigns and violations enabled). |
| Custom response-value anonymization list | `app_firewall.custom_anonymization` | A 3-way typed list (cookie/header/query-param name) — deferred; this app supports the built-in `default_anonymization` (masks card/pass/pwd/password parameters). |
| A specific pre-allocated Public IP / site-scoped placement | `*.advertise_on_public` / `*.advertise_custom` | Both reference infrastructure objects (a pre-allocated `public_ip`, a `site`/`virtual_site`) this app does not manage. `advertise_on_public_default_vip` (F5-assigned, no extra object needed) and `do_not_advertise` are fully supported. |
| Per-pool weight/priority tuning | `default_route_pools` / `origin_pools_weights` | Multiple pools are attached with equal weight; fine-grained per-pool `weight`/`priority` is deferred — most deployments use either one pool or several equally-weighted pools. |
| `cookie_stickiness` / `ring_hash` load-balancing algorithms | `http_loadbalancer.{cookie_stickiness,ring_hash}` | Each needs an additional hash-key sub-configuration beyond a simple boolean choice — `round_robin`/`least_active`/`random`/`source_ip_stickiness` are fully supported. |
| CSRF Policy, Trusted/Blocked Clients, Protected Cookies, `more_option` (compression/header manipulation), WAF Exclusions | `http_loadbalancer.*` | Real, declarative surfaces, each with its own non-trivial nested shape — deferred to a future pass rather than bolted on. |
| Legacy Service Policy Rule references | `service_policy.legacy_rule_list` | A deprecated back-reference mechanism to standalone `service_policy_rule` objects, superseded by the inline `rule_list` this app supports. |
| `interface` / `namespace` / `prefix_list` endpoint choices | `network_policy.endpoint` | Two of the seven endpoint choices are marked `(Deprecated)` upstream; `prefix_list` is deferred alongside them — `any`/`inside_endpoints`/`outside_endpoints`/`label_selector` (the four current, non-deprecated choices) are fully supported. |
| TLS certificate objects, Sites / Customer Edge provisioning, Virtual K8s, Namespaces themselves, Users/Roles/RBAC, DNS Load Balancers/Zones, BGP ASN Sets, IP Prefix Sets, Secrets (Blindfold/Vault) | various | Infrastructure provisioning, identity/access administration, and secret management — out of scope for this app the same way `ping-identity`'s Users/Environments and `okta-identity`'s Identity Governance are out of scope for those apps: this app manages traffic-delivery and traffic-security CONFIGURATION within an existing namespace, not the platform's own infrastructure or access model. |

Verified against F5's own generated Terraform provider
(`volterraedge/terraform-provider-volterra`, the same code F5 publishes for Terraform users) as of
2026-08, plus the F5 XC public docs referenced per config type below.

## Health check

Handlers probe `GET /config/namespaces/{namespace}/healthchecks` (a list call, even with zero
items) — a single low-cost read that proves the API Token is valid and the namespace exists —
before doing any per-configuration-type work.

## References

- F5 Distributed Cloud API docs: <https://docs.cloud.f5.com/docs/api>
- `volterraedge/terraform-provider-volterra` (F5's own generated Terraform provider — source of
  truth for exact endpoint paths, JSON field names, and enum values used to build this app):
  <https://github.com/volterraedge/terraform-provider-volterra>
  - Object plural / CRUD verbs: decompiled grpc-gateway route literals in
    `pbgo/extschema/schema/**/public_crudapi.pb.gw.go`
  - Enum values (`endpoint_selection`, `loadbalancer_algorithm`): `pbgo/extschema/schema/cluster/types.pb.go`
  - Auth model: `docs/resources/volterra_api_credential.md`
- Per-object API references: [HTTP Load Balancer](https://docs.cloud.f5.com/docs-v2/api/views-http-loadbalancer),
  [TCP Load Balancer](https://docs.cloud.f5.com/docs-v2/api/views-tcp-loadbalancer),
  [Origin Pool](https://docs.cloud.f5.com/docs-v2/api/views-origin-pool),
  [Healthcheck](https://docs.cloud.f5.com/docs-v2/api/healthcheck),
  [App Firewall](https://docs.cloud.f5.com/docs-v2/api/app-firewall),
  [Service Policy](https://docs.cloud.f5.com/docs/api/service-policy),
  [Malicious User Mitigation](https://docs.cloud.f5.com/docs-v2/api/malicious-user-mitigation),
  [Network Policy](https://docs.cloud.f5.com/docs-v2/api/network-policy)

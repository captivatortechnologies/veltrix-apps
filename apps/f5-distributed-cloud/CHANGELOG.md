# Changelog

All notable changes to the F5 Distributed Cloud app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the F5 Distributed Cloud (XC) config-as-code app, built research-first against
F5's own generated Terraform provider
([`volterraedge/terraform-provider-volterra`](https://github.com/volterraedge/terraform-provider-volterra))
and the F5 XC public API docs (<https://docs.cloud.f5.com/docs/api>).

Chose **F5 Distributed Cloud (XC)** over BIG-IP iControl REST for this first release: F5 XC's
tenant + namespace + single-API-Token model fits the platform's per-tenant connection model the
same way this catalog's other SaaS security platforms do, whereas BIG-IP's per-appliance
basic-auth/device model is already well represented by this catalog's device-based network apps.

Eight configuration types, covering the core declarative surface of the F5 XC public config API:

- **HTTP Load Balancers** (`config-types/http-load-balancers`) — domains, TLS mode (plain HTTP or
  F5-managed HTTPS), default route pools + optional per-path routes, load balancing algorithm, WAF
  / malicious-user-mitigation / rate-limit attachment, CORS, service policy attachment, advertise
  mode, via `/http_loadbalancers`.
- **TCP Load Balancers** (`config-types/tcp-load-balancers`) — listener, origin pool attachment,
  TLS mode, hash/load-balancing policy, service policy attachment, SNI, via `/tcp_loadbalancers`.
- **Origin Pools** (`config-types/origin-pools`) — backend server pools, endpoint selection policy,
  load balancing algorithm, health check attachment, port and TLS-to-origin settings, via
  `/origin_pools`.
- **Health Checks** (`config-types/health-checks`) — HTTP/TCP/UDP-ICMP probes, interval, timeout,
  and healthy/unhealthy thresholds, via `/healthchecks`.
- **App Firewalls** (`config-types/app-firewalls`) — WAF enforcement mode, F5-default detection
  profile, bot protection, response-code allow-listing, and blocking page, via `/app_firewalls`.
- **Service Policies** (`config-types/service-policies`) — L7 allow/deny rules scoped by ASN,
  country or IP prefix, or a custom rule list, via `/service_policys` (irregular plural, confirmed
  against F5's own generated route literals).
- **Malicious User Mitigation** (`config-types/malicious-user-mitigations`) — per-threat-level
  (low/medium/high) bot/fraud mitigation actions, via `/malicious_user_mitigations`.
- **Network Policies** (`config-types/network-policies`) — L3/L4 ingress/egress ACLs scoped to a
  set of endpoints, via `/network_policys` (irregular plural).

Authentication is a single F5 XC **API Token** credential (`Authorization: APIToken <token>`),
with the connection's tenant Console hostname stored as the `f5xc-namespace` component hostname
and the namespace this connection manages as an app setting — verified directly against F5's own
generated Terraform provider docs and decompiled grpc-gateway route literals rather than assumed
(two object types, `service_policys` and `network_policys`, have an irregular "+s" plural, not
standard English pluralization).

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus
deferred to a future pass (Bot Defense, standalone Rate Limiter/Rate Limiter Policy, Forward Proxy
Policies, Alert Receivers/Policies, customer-uploaded TLS certificates, and several deep
per-feature tuning surfaces).

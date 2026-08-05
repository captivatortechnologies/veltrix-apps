# Changelog

All notable changes to the Barracuda WAF-as-a-Service app are documented here.

## 0.1.0 — 2026-08-05

Initial release. Built against the live WAF-as-a-Service v4 OpenAPI document
after Barracuda Email Gateway Defense (the originally-targeted product) failed
this catalog's config-as-code viability gate — see the README's pivot note for
the full evidence (EGD's public API is a beta, region-limited, read-only-only
surface: three resources, one scope, `ess:account:read`, no write operation
anywhere).

### Added

- **Basic Security** (`basic-security`) — the WAF engine's protection mode
  (Active/Passive) via `/applications/{appName}/basic_security/`. Singleton.
- **IP Reputation** (`ip-reputation`) — GeoIP/IP-reputation blocking (Tor,
  anonymous/public proxies, datacenters, attack sources, fake crawlers,
  blocked countries) and its IP exception list via
  `/applications/{appName}/ip_reputation/`. Singleton.
- **DDoS Allow List** (`ddos-allow-list`) — IP/CIDR entries exempted from the
  DDoS protection engine via `/applications/{appName}/ddos/allow_list/`.
  Canvas-owns-the-list reconciliation by IP address (the paired DDoS Block
  List is read/delete-only in the API — not modeled, see Coverage).
- **Header Allow/Deny Rules** (`header-allow-deny`) — named per-header
  attack-type blocking rules via
  `/applications/{appName}/headers_allow_deny/rules/`. Canvas-owns-the-list
  reconciliation by rule name.
- **Parameter Protection** (`parameter-protection`) — application-wide
  parameter value/length/instance limits, file-upload controls and
  per-attack-type settings via
  `/applications/{appName}/parameter_protection/`. Singleton.
- **URL Protection** (`url-protection`) — application-wide allowed HTTP
  methods/content types, CSRF prevention, request/upload limits and
  per-attack-type settings via `/applications/{appName}/url_protection/`.
  Singleton.
- **Traffic Rules** (`traffic-rules`) — named host/URL-match routing rules to
  backend Servers/Endpoints via `/applications/{appName}/traffic_rules/`.
  Canvas-owns-the-list reconciliation by rule name.
- **Rate Control Pools** (`rate-control-pools`) — named rate-control pools
  (request-rate limiting, optional preferred clients and URL scoping) via
  `/applications/{appName}/rate_control/pools/`. Canvas-owns-the-list
  reconciliation by pool name.
- **Response Pages** (`response-pages`) — named custom violation/error
  response pages via
  `/applications/{appName}/response_page_component/pages/`.
  Canvas-owns-the-list reconciliation by page name.

### Notes

- Auth is a Barracuda Cloud Control admin email/password, exchanged for a
  short-lived session token (`POST /api_login/` → `{key, expiry}`, sent as
  the `auth-api` header on every call) — see `lib/barracudaWaf.ts`.
- Each configuration type targets one Application, addressed by the
  registered `barracuda-waf` component's hostname (the Application name) —
  the same convention this codebase uses for Cloudflare zones.
- See the README's [Coverage](README.md#coverage-v010) section for the full
  audit, including what was intentionally left out and why (the DDoS Block
  List, the Header Allow/Deny master toggle, Rate Control Pool nested
  sub-resources, SNI Certificate/Trusted CA, Trusted Hosts, Application/
  AppGroup provisioning, and the ~30 further per-Application resources this
  API exposes that are candidates for a future release).

# Changelog

All notable changes to the Darktrace app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first (and, honestly, the only clearly writable)
config type.

- **Watched Domains** config type — add / remove Darktrace intel-feed entries
  (domain / IP / hostname, source list, description, expiry, hostname &amp; Antigena
  flags) over the Darktrace REST API (`GET/POST /intelfeed`, 443), with validate /
  deploy (idempotent add — upsert by entry) / rollback (remove exactly what was
  added) / health-check / drift-detect (flag entries removed upstream) / status.
- **DSA auth** — the two-token (public + private) Darktrace Signed API scheme, with
  `DTAPI-Token` / `DTAPI-Date` / `DTAPI-Signature` headers. The signing assembly
  (`HMAC-SHA1` over `"<request-uri>\n<public token>\n<date>"`, compact UTC date,
  alphabetically-sorted query) is isolated in `lib/darktraceApi.ts` and pinned by
  unit tests against golden vectors.
- **Connectivity test** against the Darktrace REST API (`GET /intelfeed?sources=true`,
  HTTPS, self-signed tolerated) using the DSA token pair.
- **Client** — Overview (fed by the app's `/meta` route, honest about the read-heavy
  API), Setup Guide (token pair → connection → author), and Connections (wraps the
  SDK `ConnectionsManager`; the public token is the username, the private token the
  secret; saving a connection registers `darktrace` as a deploy target).

> Darktrace's API is **read-heavy**; the intel feed is its primary writable surface,
> so this app manages exactly that. The DSA signing details (SHA1 vs SHA256, the
> compact `DTAPI-Date` format, whether POST bodies are signed, and the exact
> `/intelfeed` parameter names) are confirmed against public API clients but should
> be **verified against a live Darktrace** — see the README.

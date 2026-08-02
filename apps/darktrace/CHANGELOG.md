# Changelog

All notable changes to the Darktrace app are documented here.

## 0.2.0 — 2026-08-01

Adds Darktrace's second cleanly-writable config surface — **tags** — alongside the
intel feed.

- **Tags** config type — create / delete Darktrace tags (a named label plus an
  optional HSL-hue colour and description) over the Darktrace REST API (`GET /tags`,
  `POST /tags`, `DELETE /tags/{tid}`, 443), with validate / deploy (idempotent create
  — upsert by tag name) / rollback (delete exactly the tags this deploy created, by
  the numeric `tid` recorded at deploy time) / health-check / drift-detect (flag tags
  deleted upstream) / status. Reuses the same DSA signer as the intel feed.
- **Signer** — `lib/darktraceApi.ts` gains a `dtDelete` helper (a DSA-signed `DELETE`
  over the existing self-signed-tolerant transport) so tag deletion signs identically
  to every other request.

### An honest note on Darktrace's write surface

Darktrace's REST API is **read-heavy** — most of it reports *out* of the platform
(model breaches, device summaries, AI Analyst, `/status`, `/summarystatistics`).
Researching the official API (customer portal + the public `LegendEvent/darktrace-sdk`
and `madsky/dtapi` clients) for genuinely-writable, config-shaped surfaces found:

- **`/intelfeed`** — the Watched Domains feature. There is **no separate
  "watched-domains" endpoint**; `/intelfeed` *is* it (already shipped in v0.1.0).
- **`/tags`** — create / delete named tags. Cleanly config-as-code (create-by-name,
  delete-by-id, no edit), mirroring the intel-feed lifecycle. **Added here.**
- **`/filtertypes`** — investigated and **rejected**: it is **read-only** (GET only,
  Model-Editor filter discovery), not a writable surface.
- **`/subnets`** — writable via `POST` but keyed on a **required numeric `sid`** (edit
  an existing *discovered* subnet's metadata), which is a weaker config-as-code fit
  than tags. Deferred, not invented.
- Model / component editing is possible in principle but is complex, stateful and not
  cleanly declarative — deliberately **not** attempted.

> `/tags` shapes (the `POST /tags` create-response fields incl. whether it returns the
> new `tid`, the `DELETE /tags/{tid}` form, and the accepted colour range) are
> confirmed against the public SDK clients but should be **verified against a live
> Darktrace** — see the README.

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

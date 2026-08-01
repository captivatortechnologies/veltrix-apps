# Changelog

All notable changes to the Akamai app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Network Lists** config type — create / update / delete an Akamai Network List
  (`name`, `type` IP/GEO, `description`, elements) and sync its content over the
  **Network Lists API v2**, with validate / deploy (upsert by list name, full
  element replace via `PUT` using the live `syncPoint`) / rollback (restore prior
  content, or delete a list we created) / health-check / drift-detect / status.
- **EdgeGrid (EG1-HMAC-SHA256) signer** — isolated in `lib/akamaiApi.ts` and
  unit-tested against the canonical data-to-sign assembly and the documented
  signing-key + signature derivation. Credentials map from an `.edgerc`:
  `host` → connection endpoint, `client_token` → credential username,
  `access_token` → credential API token, `client_secret` → credential password.
- **Connectivity test** against the Network Lists API
  (`GET /network-list/v2/network-lists?listType=IP&includeElements=false`).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (EdgeGrid
  credential → connection → author) and Connections (wraps the SDK
  `ConnectionsManager`; saving a connection registers `akamai` as a deploy
  target).

> Activating a network list (STAGING / PRODUCTION) is a **separate** Akamai step
> and is **out of scope** for v0.1.0 — this manages list content only.
>
> The EdgeGrid signing algorithm is fully specified and implemented from Akamai's
> official reference signers; verify the end-to-end request against a live Akamai
> tenant. No real-Akamai known-answer vector is embedded in the tests.

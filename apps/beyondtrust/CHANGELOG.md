# Changelog

All notable changes to the BeyondTrust app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Functional Accounts** config type — create / list Password Safe functional
  accounts (platform ID, account name, domain, display name, description,
  elevation command, optional password) over the BeyondInsight REST API, with
  validate / deploy (create-if-absent upsert) / rollback (delete the accounts this
  deploy created) / health-check / drift-detect / status.
- **Connectivity test** against the BeyondInsight REST API (`POST /Auth/SignAppIn`
  → `POST /Auth/Signout`, HTTPS, self-signed tolerated) using a PS-Auth API key and
  run-as user.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key +
  run-as user → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a Password Safe host; saving a connection registers
  `beyondtrust-passwordsafe` as a deploy target).

> BeyondInsight / Password Safe REST paths follow the public v3 API and should be
> verified against a live BeyondTrust instance. Password Safe has **no update (PUT)
> endpoint** for functional accounts, so deploy is create-if-absent — changing an
> existing account means delete + recreate (which loses its stored secret) and is
> never done implicitly. TLS verification is off by default (self-signed) and
> configurable via the `verify_tls` setting.

# Changelog

All notable changes to the Akamai app are documented here.

## 0.2.0 — 2026-08-01

Two new Edge Security config types, both reusing the v0.1.0 EdgeGrid signer.

- **Network List Activation** config type — promote a Network List onto
  **STAGING** or **PRODUCTION** over the **Network Lists API v2**
  (`POST /network-list/v2/network-lists/{id}/environments/{env}/activate`;
  status via `GET .../environments/{env}/status`). Fields: `networkListName`
  (identity — resolved to the list's `uniqueId` by name), `network`
  (STAGING/PRODUCTION), `comments`, `notificationRecipients`.

  > **Action semantics (read this).** Activation is an ACTION, not a
  > desired-state object, so the handlers model it honestly:
  > - **deploy is idempotent** — it reads the current activation status first and
  >   **skips** a list already `ACTIVE` at its current `syncPoint`, and **leaves
  >   alone** a list whose activation is already in flight (`PENDING_ACTIVATION` /
  >   `PENDING_DEACTIVATION`). Only a stale/inactive target is (re)activated.
  > - **rollback cannot un-activate.** The public Network Lists API v2 exposes
  >   `activate` + `status` but **no deactivation endpoint**, so rollback is a
  >   truthful no-op: it reports what was activated and how to revert manually
  >   (re-activate a prior `syncPoint`, or deactivate in Control Center). It never
  >   fails, so it won't block a pipeline.
  > - **drift** = the target is no longer `ACTIVE` at the list's latest
  >   `syncPoint` (Akamai's `MODIFIED` state — unactivated edits exist).
  >
  > Endpoints and activation states verified against techdocs.akamai.com
  > (`post-network-list-activate`, `get-network-list-status`,
  > `activation-states`). Fast activation typically completes in <10 minutes and
  > finishes asynchronously; a triggered activation returns `PENDING_ACTIVATION`.

- **Client Lists** config type — manage Akamai **Client Lists**, the newer,
  richer replacement for Network Lists, over the **Client Lists API v1**. Types:
  `IP`, `GEO`, `ASN`, `TLS_FINGERPRINT`, `FILE_HASH`, `USER_ID`, `DOMAIN`,
  `REQUEST_HEADER_NAME_VALUE`. Upsert by list **name** with
  validate / deploy (create via `POST /client-list/v1/lists`; update details via
  `PUT /client-list/v1/lists/{id}`; full-replace entries via
  `POST /client-list/v1/lists/{id}/items` with `append`/`delete`) / rollback
  (restore prior details + entries, or delete a list we created) / health-check /
  drift-detect / status. Fields: `name`, `type`, `contractId`, `groupId`,
  `notes`, `tags` (≤5, ≤256 chars each), `items`.

  > **Endpoint provenance / FLAG.** Akamai's interactive Client Lists API
  > reference (`techdocs.akamai.com/client-lists/reference`) is **login-gated**,
  > so the paths, HTTP methods and request/response field names above were taken
  > from Akamai's **official open-source Go SDK**
  > (`github.com/akamai/AkamaiOPEN-edgegrid-golang`,
  > `pkg/clientlists/client_list.go`) — the same client the Akamai Terraform
  > provider is built on — cross-checked against the public Terraform resource
  > docs (`cl-rc-client-list`, type enum) for field shapes. Treat these as
  > **verified against the SDK but not against the HTML reference**; confirm the
  > `{ content: [...] }` collection envelope and the create requirement for
  > `contractId` + `groupId` against a live Client Lists-entitled tenant.
  >
  > **Scope:** this config manages Client List **content** only. Client List
  > **activation** (`POST /client-list/v1/lists/{id}/activations`, body
  > `{ action, network, comments, notificationRecipients, siebelTicketId }`) is a
  > separate step and is a deliberate follow-up, mirroring how Network List
  > content and activation are split across two config types here.
  >
  > **App & API Protector / Security Configurations** (rate policies, match
  > targets, custom rules) were evaluated as the second surface and **dropped for
  > this release**: they require versioned security-config management plus their
  > own activation lifecycle — too much for a foundation. Client Lists was chosen
  > as the cleaner, self-contained write path.

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

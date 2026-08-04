# Changelog

All notable changes to the Akamai app are documented here.

## 0.3.0 — 2026-08-04

Config-as-code surface exhaustion pass: the full Akamai OPEN API index was
re-surveyed (techdocs.akamai.com reference pages, cross-checked against the
official Go SDK `github.com/akamai/AkamaiOPEN-edgegrid-golang` — the same
client the Akamai Terraform provider is built on — since several interactive
API references are login-gated, the same provenance already used for Client
Lists in v0.2.0) and classified into clean-CRUD surfaces worth adding versus
heavyweight/out-of-scope surfaces to drop. Six new config types across three
new products, all reusing the existing EdgeGrid signer unchanged.

### Added

- **DNS Zones (`dns-zones`)** — create/update Akamai **Edge DNS** zones
  (PRIMARY / SECONDARY / ALIAS) over the **Edge DNS API v2**
  (`POST /config-dns/v2/zones?contractId=..&gid=..`,
  `PUT /config-dns/v2/zones/{zone}`). Unlike Network Lists / Client Lists, the
  zone **name is the URL identity itself** — no server-assigned opaque id to
  resolve first — so deploy/rollback/drift all `GET` the zone directly by name
  rather than listing-then-matching. Fields: `zone`, `type`, `contractId`,
  `groupId`, `comment`, `masters` (SECONDARY), `target` (ALIAS),
  `signAndServe` + `signAndServeAlgorithm` (DNSSEC), `endCustomerId`, and an
  `advanced` JSON blob for the rarely-used nested `tsigKey` /
  `outboundZoneTransfer` objects (typed fields win on key collision — the same
  "typed fields + JSON blob for the long tail" idiom as Cisco Meraki's Group
  Policies).

  > **Zone deletion is asynchronous.** Edge DNS has no synchronous single-zone
  > `DELETE` — the only way to remove a zone is the bulk
  > `POST /config-dns/v2/zones/delete-requests`, which queues an offline task
  > and Akamai refuses outright if the zone is still receiving DNS queries or
  > is delegated. Rollback of a zone this app created **requests** deletion
  > (fire-and-forget) rather than confirming it — reported honestly as
  > "requested", not "deleted".

- **DNS Records (`dns-records`)** — create/update/delete individual **Edge
  DNS** recordsets over the same API
  (`POST`/`PUT`/`DELETE /config-dns/v2/zones/{zone}/names/{name}/types/{type}`).
  The real API is deliberately generic — every record type is
  `{ name, type, ttl, rdata }` where `rdata` is a raw array of
  presentation-format strings (e.g. `"10 mail.example.com."` for MX) — so this
  config type mirrors the API's own shape instead of inventing one field per
  record type the way Terraform's provider does. The `(zone, name, type)`
  triple is the real identity (a compound identity expressed as one
  `identityField`, the same convention Network List Activation uses for its
  `networkListName + network` pair). Per-record deletion is a real,
  synchronous `DELETE` (unlike zone deletion), so rollback of a record this
  app created is a genuine, confirmed delete. 25 record types are selectable
  (A/AAAA/CNAME/MX/NS/TXT/SRV/CAA/PTR/NAPTR/SSHFP/TLSA/DS/DNSKEY/CERT/HINFO/RP/
  HTTPS/SVCB/NSEC3/NSEC3PARAM/AFSDB/RRSIG/LOC/SPF); SOA (auto-created with the
  zone) and Akamai's read-only `AKAMAITLC` answer-assignment records are
  intentionally excluded.

- **Cloudlets Policies (`cloudlets-policies`)** — create/update/delete Akamai
  **Cloudlets** shared policies (API Prioritization, Audience Segmentation,
  Phased Release, Edge Redirector, Forward Rewrite, Request Control) and their
  match-rule versions over the **Cloudlets API v3** (shared policies only —
  the only kind v3 supports). Reconciled by **name**:
  `GET /cloudlets/v3/policies` → match → `PUT .../policies/{id}` (group/
  description) or `POST /cloudlets/v3/policies` (create), then
  `POST /cloudlets/v3/policies/{id}/versions` for the match-rule content.
  Fields: `name`, `cloudletType`, `groupId`, `description`,
  `versionDescription`, and `matchRules` as **one JSON array blob** — the
  per-cloudlet-type match/action schema is large and type-specific (874 lines
  in the Go SDK's `match_rule.go` alone), so — following Cisco Meraki's Group
  Policies / Cribl's Sources-Destinations precedent — it is authored as raw
  JSON rather than dozens of nested canvas fields; Cloudlets itself validates
  the nested shape at deploy time.

  > **Versions are immutable once activated.** Rather than tracking
  > draft-vs-immutable state, deploy always creates a **new** version when the
  > latest version's `matchRules`/description differ from what's declared —
  > simpler and side-effect-safe at the cost of a new version number per edit,
  > which Cloudlets' own version history already expects. Activating a
  > version is a **separate** config type (below) — the same content/
  > promotion split this app already uses for Network Lists.

- **Cloudlets Policy Activation (`cloudlets-policy-activation`)** — activate
  or deactivate a Cloudlets policy version onto **STAGING**/**PRODUCTION**
  (`POST /cloudlets/v3/policies/{id}/activations`,
  `{ operation: "ACTIVATION" | "DEACTIVATION", network, policyVersion }`).
  Deploy is idempotent the same way Network List Activation is (skips a
  target already effective at the declared version; leaves an in-flight
  request alone) — fields: `policyName`, `policyVersion`, `network`.

  > **Real rollback, unlike Network List Activation.** The Cloudlets API
  > exposes a genuine `DEACTIVATION` operation on the same endpoint, so
  > rollback here actually undoes an activation — re-activating the prior
  > effective version, or deactivating outright if there was none — instead
  > of the honest forward-only no-op Network List Activation documents (the
  > public Network Lists API v2 has no deactivate endpoint at all).

- **EdgeWorkers (`edgeworkers`)** — create/update/delete Akamai **EdgeWorker**
  identities over the **EdgeWorkers API v1**
  (`POST`/`PUT`/`DELETE /edgeworkers/v1/ids[/{edgeWorkerId}]`), reconciled by
  **name**. Fields: `name`, `groupId`, `resourceTierId`.

  > **Scope: identity only.** An EdgeWorker's JavaScript code bundle is a
  > gzipped tarball (`bundle.json` + `main.js`) uploaded as binary content —
  > there is no clean text/JSON canvas representation for it, unlike every
  > other surface in this app, so version creation/upload is **out of
  > scope** here and ships via CI/CD or the Akamai CLI instead (the same
  > treatment this app already gives certificate private keys and IdP
  > secrets: manage the declarative wrapper, not the opaque binary/secret
  > payload). Promoting an **existing** version is the next config type.

- **EdgeWorker Activation (`edgeworker-activation`)** — activate an existing
  EdgeWorker code-bundle version onto **STAGING**/**PRODUCTION**
  (`POST /edgeworkers/v1/ids/{id}/activations`,
  `{ network, version, note }`). Idempotent the same way Network List
  Activation is. Fields: `edgeWorkerName`, `version`, `network`, `note`.

  > **Real rollback, unlike Network List Activation.** EdgeWorkers exposes a
  > genuine deactivation **resource** (`POST .../deactivations`, a separate
  > endpoint from activation rather than a flag on the same call), so
  > rollback here — like Cloudlets Policy Activation above — actually undoes
  > the promotion: re-activating the prior effective version, or
  > deactivating outright if there was none. Effective state per network is
  > derived client-side (the activations list has no per-network filter) as
  > the most-recently-created, non-in-flight, non-failed request for that
  > network.

### Evaluated and dropped (with reason)

- **CPS (Certificate Provisioning System) enrollments** — even the
  "non-secret" configuration (SANs, validation type, network deployment
  settings) is inseparable from an async, multi-step domain-validation /
  certificate-issuance lifecycle (DV challenge records, CSR generation,
  staging → production deployment slots). A partial "enrollment metadata"
  surface without that lifecycle would be honest-but-useless; the lifecycle
  itself is too heavyweight and stateful for a clean idempotent CRUD config
  type, the same bar that excludes PAPI property rule-trees.
- **App & API Protector / Application Security configurations (WAF)** — rate
  policies, match targets, custom rules and firewall rules all live inside a
  **versioned security configuration** with its own STAGING/PRODUCTION
  activation lifecycle, layered on top of already deeply-nested per-rule
  schemas. Evaluated and dropped for this exact reason in v0.2.0; re-verified
  this release and the conclusion stands — no clean, version-independent
  sub-API exists.
- **Bot Manager** — bot categories, detections and actions are configured
  **as part of** an Application Security configuration version, inheriting
  the same versioned-config-plus-activation complexity as WAF above; there is
  no standalone clean sub-API.
- **SIEM** — the SIEM API is a **read-only** security-event log retrieval/
  streaming surface (integration setup itself happens in Control Center, not
  over a write-config REST resource). Not a config-as-code write surface at
  all, so out of scope regardless of complexity.
- **IAM users / groups / roles** — verified as genuinely clean CRUD
  (`identity-management/v3/user-admin/{ui-identities,roles,groups}`,
  full create/read/update/delete on all three) but deliberately excluded:
  Control-Center identity and access administration is account-wide,
  security-sensitive control-plane bootstrap, not edge-security/edge-delivery
  configuration — the same boundary Cisco Meraki draws around organization
  administrators in this monorepo ("Credential/API-key and SAML
  administration is security-sensitive control-plane bootstrap, not canvas
  configuration").

### Other

- `lib/akamaiApi.ts` gains the base collection-path constants for the three
  new products (`DNS_ZONES_PATH`, `DNS_ZONE_DELETE_REQUESTS_PATH`,
  `CLOUDLETS_POLICIES_PATH`, `EDGEWORKERS_IDS_PATH`); the EdgeGrid signer and
  REST client are unchanged since v0.1.0 and reused as-is.
- Every configuration type now declares a sidebar `group`: "Edge Security"
  (Network Lists, Network List Activation, Client Lists — unchanged),
  "Edge DNS" (DNS Zones, DNS Records), "Cloudlets" (Cloudlets Policies,
  Cloudlets Policy Activation) and "EdgeWorkers" (EdgeWorkers, EdgeWorker
  Activation).
- Provenance note: the Edge DNS / Cloudlets / EdgeWorkers endpoint paths,
  methods and request/response field names above were verified against
  `AkamaiOPEN-edgegrid-golang`'s `pkg/dns`, `pkg/cloudlets/v3` and
  `pkg/edgeworkers` packages (the library the Akamai Terraform provider
  itself is built on) — treat as **verified against the SDK** but not against
  a live tenant; the Cloudlets/EdgeWorkers activation status enums in
  particular are asserted defensively (known in-flight/failed statuses
  matched by name, everything else treated as terminal-success) since the
  interactive API reference for activation states is not fully enumerated in
  the public docs.

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

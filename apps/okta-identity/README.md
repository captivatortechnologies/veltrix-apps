# Okta

Manage [Okta](https://www.okta.com/) configuration as code through the Okta Management API. Author
configurations in the platform's Configuration Canvas and deploy them through the Security-as-Code
pipeline — validate, deploy, health check, drift detection and rollback are handled per configuration
type.

## Credentials

The app authenticates every request with an Okta API token, sent as `Authorization: SSWS <token>`.
Create one in the Okta Admin console under **Security → API → Tokens** — a token inherits the
permissions of the admin who created it, so create it as an admin scoped to what this app manages.
Store it as a Veltrix credential:

| Veltrix credential field | Okta value |
| --- | --- |
| API token | An Okta API token (SSWS) |

Register an **`okta-org`** component whose hostname is your Okta org domain (e.g. `dev-12345.okta.com`
or `acme.oktapreview.com`) and attach the credential.

## What it manages

| Configuration type | Okta object | API |
| --- | --- | --- |
| Policies | Sign-on / password / authenticator-enrollment policies + rules | `/policies` |
| Group Rules | Dynamic group-assignment rules | `/groups/rules` |
| Groups | Groups (OKTA_GROUP) + optional static membership | `/groups` |
| Network Zones | IP / dynamic network zones | `/zones` |
| Trusted Origins | CORS / redirect / iframe-embed allowlist | `/trustedOrigins` |
| Behavior Rules | Behavioral detection rules | `/behaviors` |
| Authenticators | Authenticator config + enablement (no delete) | `/authenticators` |
| Identity Providers | External IdPs (OIDC/SAML/social) — sensitive | `/idps` |
| Event Hooks | Event hooks (delete needs INACTIVE; secret write-only) | `/eventHooks` |
| Inline Hooks | Inline hooks (token/SAML transforms; secret write-only) | `/inlineHooks` |
| Authorization Servers | Custom OAuth authorization servers | `/authorizationServers` |
| Auth Server Scopes | OAuth scopes on an authorization server | `.../scopes` |
| Auth Server Claims | OAuth claims on an authorization server | `.../claims` |
| Auth Server Policies | OAuth access policies + rules | `.../policies` |
| Applications | App integrations (OIDC/SAML/SWA/bookmark) — secrets write-only | `/apps` |
| App Group Assignments | Assign groups to applications | `/apps/{id}/groups` |
| ThreatInsight | Org suspicious-request handling (none/audit/block) + exempt zones (singleton) | `/threats/configuration` |
| Log Streams | System Log export to AWS EventBridge / Splunk Cloud (Splunk token write-only) | `/logStreams` |
| Device Assurance Policies | Per-platform device posture requirements | `/device-assurances` |
| User Types | User type definitions (name immutable; default type protected) | `/meta/types/user` |
| Custom Admin Roles | Least-privilege custom admin roles + permissions | `/iam/roles` |
| Resource Sets | Resource collections that scope custom admin roles | `/iam/resource-sets` |

## Okta-specific behaviour the app handles

Okta objects are `id`-keyed with **no upsert**, and several have lifecycle rules the app enforces:

- **No upsert** — a deploy lists the objects, matches by logical key (name/type), and updates in place
  or creates; the Okta `id` is captured for rollback.
- **Group rules must be deactivated before update**, and their `actions` block is immutable — changing
  which groups a rule assigns means delete-and-recreate, which the app does automatically. Rules are
  born inactive and activated explicitly.
- **Network zones can't be deleted while active** (on Identity Engine) or while referenced by a policy
  or rule — the app deactivates first and surfaces reference errors clearly.
- **Built-in objects are never touched**: the default policy per type and its default rule, `BUILT_IN`
  groups (e.g. `Everyone`) and `APP_GROUP` groups, and the system network zones (`LegacyIpZone`,
  `BlockedIpZone`, `DefaultEnhancedDynamicZone`, `DefaultExemptIpZone`) — all update-in-place only,
  never deleted.
- **Group membership is opt-in per group.** Don't manage static membership on a group targeted by a
  group rule — rule-assigned members can't be removed through the membership API and would show as
  permanent drift.
- **Write-only secrets are excluded from drift.** The event-hook auth header value, inline-hook secret,
  IdP/app client secrets and the Splunk log-stream HEC token are never returned by Okta, so they are
  re-sent on deploy where the API allows and never drift-checked. (The log-stream token is additionally
  immutable, so it is sent only at create.)
- **Immutable fields → delete-and-recreate.** A log stream's `type`/`settings`, a device assurance
  policy's `platform`, and a user type's `name` cannot be changed after creation; the app resends them
  unchanged on update and surfaces a clear "delete and recreate" error if you change them.
- **Sub-resource reconciliation.** Custom admin role permissions and resource-set resources are only
  accepted in bulk at create time. On update the app diffs the desired set against live and adds/removes
  members one at a time through the role's `/permissions` and the set's `/resources` sub-resources.
- **Delete preconditions are surfaced.** A device assurance policy mapped to an Authentication Policy,
  a user type still assigned to users, and a custom role/resource set still bound to a principal cannot
  be deleted until the reference is removed — the app reports the specific reason on a failed rollback.
- **Protected/system objects are never created or deleted:** the default user type, Okta's standard
  admin roles (`SUPER_ADMIN`, `ORG_ADMIN`, …), and the ThreatInsight singleton (updated in place only).

The complex, per-type parts (password complexity/age/lockout, MFA authenticator settings, policy
rules, zone gateway/ASN definitions) are authored as JSON inside the canvas, since their schema is
large and type-dependent.

## Health check

Handlers probe `GET /org` — a single-object read that proves the token is valid and has admin access
before doing any work.

## References

- API reference: <https://developer.okta.com/docs/reference/>
- Policies concepts: <https://developer.okta.com/docs/concepts/policies/>

# SentinelOne

Manage [SentinelOne](https://www.sentinelone.com/) endpoint security configuration as code through
the SentinelOne Management API (v2.1). Author configurations in the platform's Configuration Canvas
and deploy them through the Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback are handled per configuration type.

## Credentials

Create a **service-user API token** in the SentinelOne console (**Settings → Users**) scoped at the
level this app manages, and store it as a Veltrix credential:

| Veltrix credential field | SentinelOne value |
| --- | --- |
| API token | The service-user API token |

The token inherits its user's role and scope, so use a token scoped at the highest level it must
manage. Every request is sent as `Authorization: ApiToken <token>` to
`https://<console>.sentinelone.net/web/api/v2.1`.

Register a **`sentinelone-console`** component whose hostname is your management console URL (e.g.
`acme.sentinelone.net`). Set the **Scope** app setting (`global`, `account`, `site` or `group`) and
the **Scope ID** (the matching account/site/group id; not needed for `global`).

## What it manages

| Configuration type | Object | Endpoint |
| --- | --- | --- |
| Exclusions | Path / file-type / hash / certificate / browser exclusions | `/exclusions` |
| Blocklist Hashes | `black_hash` block entries | `/restrictions` |
| Hash Allowlist | `white_hash` allow entries | `/restrictions` |
| STAR Rules | S1QL 2.0 custom detection rules | `/cloud-detection/rules` |
| Agent Policy | The per-scope agent policy | `/{scope}/{id}/policy` |
| Groups | Static / dynamic agent groups | `/groups` |

## SentinelOne-specific behaviour the app handles

- **Account → Site → Group scoping.** Collections carry the scope inside the request body's `filter`
  (`accountIds`/`siteIds`/`groupIds`, or `tenant:true` for global); the agent policy carries scope in
  the path. The app resolves the `Scope` + `Scope ID` settings into both forms.
- **The agent policy is a per-scope singleton.** There is no "no policy" state — the app reads the
  current policy, merges the authored keys, and PUTs the merged object (read-modify-write), and
  supports revert-to-inherit rather than delete.
- **Envelope + cursor pagination.** Responses use `{ data, pagination, errors }`; the app follows
  `pagination.nextCursor` and surfaces `errors[]` on failure. Honors 429 with backoff.
- **Identity that survives environments.** Exclusions match on `type`+`value`+`osType`+scope (no
  server key); blocklist/allowlist on the hash + scope (add/remove, no update); STAR rules track the
  server id (name is not enforced-unique); groups on `name` within a site.
- **Protected objects.** Predefined (`source ≠ user`) exclusions/restrictions and the auto-created
  Default Group are never modified or deleted.
- STAR rules are created as `Draft` (S1QL 2.0) and then enabled.

## Health check

Handlers make a cheap authenticated read at the configured scope to prove the token + scope work
before doing any work, then confirm each declared object is present.

## References

- SentinelOne Management API: `https://<console>.sentinelone.net/api-doc/` (per-tenant Swagger)
- STAR / S1QL: <https://www.sentinelone.com/blog/>

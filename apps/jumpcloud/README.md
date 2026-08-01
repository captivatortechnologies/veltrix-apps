# JumpCloud

Manage [JumpCloud](https://jumpcloud.com/) directory configuration as code through the JumpCloud REST
API. Author configurations in the platform's Configuration Canvas and deploy them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback are handled
per configuration type.

## Credentials

The app authenticates every request with a JumpCloud **API key**, sent as the `x-api-key` header.
Generate one in the JumpCloud Admin Portal under your account name → **My API Key** — the key inherits
the permissions of the admin who owns it, so use an admin scoped to what this app manages.

| Veltrix credential field | JumpCloud value |
| --- | --- |
| API key (API token) | A JumpCloud API key |
| Username (optional) | Org ID — **multi-tenant (MTP) admins only** (sent as `x-org-id`); leave blank for single-tenant |

The API endpoint is **fixed** — JumpCloud is a single global console:

- v1: `https://console.jumpcloud.com/api`
- v2: `https://console.jumpcloud.com/api/v2` (User Groups live here)

Saving a connection registers a **`jumpcloud-org`** deploy target automatically; no host to configure.

## What it manages

| Configuration type | JumpCloud object | API |
| --- | --- | --- |
| User Groups | User Groups — name, description, email, membership method | `/api/v2/usergroups` |

### User Groups

One canvas item = one User Group, matched on its **name** (the logical identity used for upsert and
drift). Each deploy:

- lists `GET /api/v2/usergroups` (paged with `limit` + `skip`) and matches by name;
- updates an existing group with `PUT /api/v2/usergroups/{id}` or creates a new one with
  `POST /api/v2/usergroups`, capturing the returned id;
- records each group's id per canvas item so a **rename** updates the same group in place instead of
  creating a duplicate (rename-safe identity), and records the prior body so rollback can restore an
  updated group or delete a created one.

The **membership method** is `STATIC` (membership managed by an administrator) or `DYNAMIC_AUTOMATED`
(JumpCloud derives membership from the group's member query). A dynamic group's member query must be
configured in JumpCloud — this config type does not author it yet, so validate warns when you pick
`DYNAMIC_AUTOMATED`.

## Health check

Handlers probe `GET /api/v2/usergroups` — a read that proves the API key is valid before doing any
work — then confirm each declared group still exists in the org.

## Verify against a live JumpCloud

API facts were confirmed from JumpCloud's public documentation and the JumpCloud API client libraries.
The `POST` / `PUT` **body fields beyond `name`** (`description`, `email`, `membershipMethod`) should be
verified against a live JumpCloud tenant — the public API model markdown enumerates only `name`, while
JumpCloud's own docs describe the wider User Group object.

## References

- JumpCloud APIs: <https://jumpcloud.com/support/jumpcloud-apis>
- Retrieve object IDs from the API (auth headers): <https://jumpcloud.com/support/retrieve-object-ids-from-the-api>
- User Groups API (methods): <https://github.com/TheJumpCloud/jcapi-python/blob/master/jcapiv2/docs/UserGroupsApi.md>

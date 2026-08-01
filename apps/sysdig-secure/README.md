# Sysdig Secure

Manage **Sysdig Secure** custom Falco (threat-detection) rules as code. Author
runtime security rules in the Configuration Canvas and drive them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback — over the Sysdig Secure REST API.

Sysdig is SaaS, so there is **no BYOL infrastructure and no app database**.

## What it manages

| Configuration type | Sysdig object | API surface |
| --- | --- | --- |
| **Falco Rules** | Custom Falco (threat-detection) rules | `/api/secure/rules` |

Each rule carries a name (identity), description, Falco `condition` expression,
alert `output`, `priority` (EMERGENCY…DEBUG), `source` (syscall, k8s_audit,
aws_cloudtrail, gcp_auditlog, azure_platformlogs, okta, github, guardduty),
optional tags, and an `enabled` flag.

## Connection & credentials

A connection is a **Sysdig tenant** addressed by its **region base URL** plus a
**Bearer API token**.

- **Region base URL** — the address of your Sysdig console, e.g.
  `https://us2.app.sysdig.com`. The US-East default is `https://secure.sysdig.com`
  (the same default the official Terraform provider uses). Set it as the
  connection endpoint; the full URL is stored, so any region works.
- **API token** — from **Settings → Sysdig Secure API** in the console, or a
  team-based / global service account. Stored as the credential's API token and
  sent as `Authorization: Bearer <token>`.

The **Test** button on the Connections page runs
`GET /api/secure/rules/groups?type=FALCO` — a 200 confirms the endpoint resolves
and the token authenticates.

## REST API reference

Custom Falco rules are individual objects under `/api/secure/rules`:

| Operation | Method & path |
| --- | --- |
| Find by name (upsert lookup) | `GET /api/secure/rules/groups?name=<name>&type=FALCO` |
| Create | `POST /api/secure/rules?skipPolicyV2Msg=true` |
| Get by id | `GET /api/secure/rules/<id>` |
| Update | `PUT /api/secure/rules/<id>?skipPolicyV2Msg=true` |
| Delete | `DELETE /api/secure/rules/<id>?skipPolicyV2Msg=true` |

The rule JSON body:

```json
{
  "name": "Unexpected outbound connection",
  "description": "…",
  "tags": ["network"],
  "details": {
    "ruleType": "FALCO",
    "source": "syscall",
    "output": "Netcat run (user=%user.name command=%proc.cmdline)",
    "condition": { "condition": "evt.type=execve and proc.name=nc", "components": [] },
    "priority": "WARNING",
    "append": false
  }
}
```

Deploy upserts by rule **name**: an existing rule is updated (carrying its live
`id` + `version`), a new one is created. Sysdig has **no per-rule enabled
toggle** — rules are enabled through policies — so `enabled: false` is modeled
as "absent from the custom rule library": a disabled rule that exists is deleted.
`rollbackData` records the action taken and the prior rule body so rollback can
restore, re-create, or remove precisely.

## Verification notes

The endpoint paths, the Bearer auth scheme, the regional base-URL convention and
the Falco-rule JSON shape were confirmed against the official
[`terraform-provider-sysdig`](https://github.com/sysdiglabs/terraform-provider-sysdig)
client and the [Sysdig API docs](https://docs.sysdig.com/en/developer-tools/sysdig-api/).
Verify against a live Sysdig Secure before production use — in particular the
exact per-region hostname (shown in your Sysdig console URL) and the priority
casing your tenant returns.

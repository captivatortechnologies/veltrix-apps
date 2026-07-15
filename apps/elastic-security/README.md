# Elastic Security

Manage [Elastic Security](https://www.elastic.co/security) configuration as code through the Kibana
and Elasticsearch APIs. Author configurations in the platform's Configuration Canvas and deploy them
through the Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback
are handled per configuration type.

## Two endpoints, one credential

Elastic Security config spans two services, both authenticated by the same Elastic API key:

- **Kibana** — detection rules, exception lists, spaces (`/api/...`)
- **Elasticsearch** — ILM policies, role mappings (`/_ilm`, `/_security`)

## Credentials

Create an API key in Kibana under **Stack Management → API keys** and copy the **Base64** value (the
encoded `id:api_key` string). Store it as a Veltrix credential:

| Veltrix credential field | Elastic value |
| --- | --- |
| API token | The Base64 `id:api_key` value |

A username + password may be used instead for Basic auth. The key inherits privileges, so scope it to
what this app manages. Every request is sent as `Authorization: ApiKey <encoded>`; Kibana calls also
carry `kbn-xsrf: true` and `elastic-api-version: 2023-10-31`.

Register an **`elastic-deployment`** component whose hostname is the **Kibana** base URL (e.g.
`https://my-deployment.kb.us-central1.gcp.cloud.es.io:9243`) and attach the credential. Set the
**Elasticsearch URL** app setting (required for ILM policies and role mappings) and, optionally, a
**Kibana space** to scope space-aware config.

## What it manages

| Configuration type | Object | Endpoint |
| --- | --- | --- |
| Detection Rules | Security detection rules (query/EQL/threshold/ML/...) | Kibana `/api/detection_engine/rules` |
| Exception Lists | Exception lists + their items | Kibana `/api/exception_lists` |
| ILM Policies | Index lifecycle policies (hot/warm/cold/delete) | Elasticsearch `/_ilm/policy` |
| Role Mappings | Role mappings (roles + a rules DSL) | Elasticsearch `/_security/role_mapping` |
| Spaces | Kibana spaces | Kibana `/api/spaces/space` |

## Elastic-specific behaviour the app handles

- **Identity keys survive environments.** Detection rules key on the stable user-defined `rule_id`
  (not the server UUID `id`); exception lists on `list_id`; ILM policies / role mappings on their
  name; spaces on `id` (which is immutable). ILM policies and role mappings are true upserts; the
  Kibana objects use list-then-create-or-update (no native upsert).
- **The rule `version` trap** — for custom detection rules `version` is set once at creation and is
  never incremented, so the app never writes it on update (the field that increments, `revision`, is
  server-managed).
- **Managed objects are never touched**: Elastic-managed prebuilt detection rules
  (`immutable: true` / `rule_source.type: external`), managed ILM policies (`_meta.managed: true` or
  dot/`@`-prefixed names), reserved role mappings (`metadata._reserved: true`), and the `default`
  Kibana space — update-in-place only where allowed, never modified/deleted.
- The large, type-dependent parts (the rule body, ILM phases, exception entries, the role-mapping
  rules DSL) are authored as JSON in the canvas.

## Health check

Handlers make a cheap read against the relevant service (a paged rule/space fetch for Kibana types, a
policy list for Elasticsearch types) to prove the credential works before doing any work.

## References

- Security APIs: <https://www.elastic.co/guide/en/security/current/security-apis.html>
- ILM: <https://www.elastic.co/guide/en/elasticsearch/reference/current/ilm-put-lifecycle.html>

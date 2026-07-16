# Palo Alto Panorama (Veltrix app)

Manage Palo Alto Networks **Panorama / PAN-OS** configuration as code through the
**PAN-OS REST API**, with commits handled via the **XML API**. Authoring happens in
the Veltrix Configuration Canvas; every write goes through the Security-as-Code
pipeline (validate → deploy → health check → drift → rollback).

## What it manages

| Config type | REST resource | Identity |
|---|---|---|
| `panorama-tags` | `/Objects/Tags` | name |
| `panorama-address-objects` | `/Objects/Addresses` | name |
| `panorama-service-objects` | `/Objects/Services` | name |
| `panorama-address-groups` | `/Objects/AddressGroups` | name |
| `panorama-service-groups` | `/Objects/ServiceGroups` | name |
| `panorama-security-rules` | `/Policies/SecurityPreRules` | name |

Deploy order matters: **tags → objects → groups → security rules** (rules
reference everything else). Security rules are created in the device-group **pre**
rulebase.

## Authentication

The credential is a **pre-generated PAN-OS API key** stored in the credential's
**API token** field. The app sends it as the `X-PAN-KEY` header on every REST
call. No username is required. Generate a key with:

```
curl -k -X POST 'https://<panorama>/api/?type=keygen' -d 'user=<u>&password=<p>'
```

Register a **`panorama`** component whose hostname is the Panorama management host
(e.g. `panorama.example.com`). HTTPS is always used.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `device_group` | `shared` | Target device group; `shared` uses the shared location, any other value uses `location=device-group` |
| `rest_api_version` | `v11.0` | REST API version segment. **Note:** this does not always equal the PAN-OS release — PAN-OS 11.1 serves `/restapi/v11.0` |
| `auto_commit` | `false` | When on, deploy/rollback commit the candidate to Panorama and poll the job |
| `verify_tls` | `true` | Informational only — see TLS note below |
| `request_timeout_seconds` | `30` | Per-request timeout |

## Deploy, commit & rollback model

* Every REST `POST/PUT/DELETE` writes only the **candidate** configuration.
* Deploy upserts each object (list → PUT existing / POST new), tracking which
  objects it **created** for rollback.
* When `auto_commit` is on, deploy commits the candidate to Panorama via the XML
  API (`type=commit`) and polls the returned job to completion (bounded ~60s).
  Committing to Panorama does **not** by itself push to managed firewalls — an
  operator still runs a device-group push (commit-all) to activate on devices.
* **Rollback** deletes only the objects this deploy created (tolerating 404),
  then commits when `auto_commit` is on. It never touches objects it did not
  create and never performs a candidate-revert.

## TLS

Panorama management certificates are commonly self-signed. Handlers run
in-process and cannot disable TLS verification, so the **platform host must trust
the Panorama certificate**. The `verify_tls` setting is informational.

## Scope & limitations

* **Security profiles** (antivirus, URL filtering, etc.) are intentionally out of
  scope — their schemas are deep and type-specific. Security rules can *reference*
  an existing security-profile group by name (`profile_group`), but the app does
  not author the profiles or groups themselves.
* Security rules are written to the **pre** rulebase; post-rules are not exposed.
* Objects that pre-existed and were updated in place are **not** restored by
  rollback (rollback only deletes what it created). Prefer letting this app own
  the objects it manages.
* Rule **ordering** within the rulebase is not managed; rules are upserted by
  name.

## Development

```
cd apps/palo-alto-panorama
node node_modules/typescript/bin/tsc --noEmit     # typecheck
node ../../scripts/test-apps.mjs palo-alto-panorama  # run tests
node ../../scripts/validate-app.mjs apps/palo-alto-panorama  # validate
```

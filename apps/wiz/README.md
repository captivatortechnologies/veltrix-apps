# Wiz (Veltrix app)

Manage [Wiz](https://www.wiz.io) (CNAPP / cloud security) configuration as code
through the **Wiz GraphQL API**, driven by the Veltrix Security-as-Code pipeline
(validate → deploy → health check → drift detect → rollback).

## What it manages

| Configuration type | Wiz object | GraphQL operations |
| --- | --- | --- |
| **Wiz Service Accounts** (`wiz-service-accounts`) | Service accounts | `serviceAccounts` (list), `createServiceAccount`, `deleteServiceAccount` |
| **Wiz Cloud Configuration Rules** (`wiz-cloud-config-rules`) | Custom cloud configuration (CSPM) rules | `cloudConfigurationRules` (list), `cloudConfigurationRule` (read), `createCloudConfigurationRule`, `updateCloudConfigurationRule`, `deleteCloudConfigurationRule` |

Both configuration types reconcile by **name** and target a `wiz-tenant`
component.

### Service accounts — write-only secret

The client secret Wiz generates for a new service account is returned **once**
and cannot be re-read. This app therefore **creates missing** service accounts
and **leaves existing ones untouched** (it never mutates or re-creates an
account). The generated secret is deliberately **never** requested, stored,
diffed, or logged — only the non-sensitive `clientId` is surfaced. Rotate the
secret in Wiz to obtain a usable value.

### Cloud configuration rules

Each rule evaluates a cloud resource (`targetNativeTypes`, e.g. `aws.s3.bucket`)
against a **Rego (OPA)** policy, with optional Infrastructure-as-Code scanning
via an IaC matcher (Terraform, CloudFormation, Kubernetes, …). Reconciliation
matches **non-builtin** rules only — built-in Wiz rules are never modified. An
updated rule's prior state is captured for rollback.

## Authentication

OAuth2 **client credentials**. Create a service account in Wiz
(**Settings → Service Accounts**, *Custom Integration (GraphQL API)*) with the
scopes this app needs, then store it as a Veltrix credential:

- **Username** → the Wiz service account **Client ID**
- **API token** → the Wiz service account **Client Secret**

The app exchanges these for a short-lived Bearer token at the tenant's auth
endpoint (`https://auth.app.wiz.io/oauth/token`, audience `wiz-api`; legacy
tenants use `https://auth.wiz.io/oauth/token`, audience `beyond-api` — derived
automatically from the **Auth Endpoint** setting).

## Component

Register a `wiz-tenant` component whose **hostname** is your regional Wiz API
host (find it in Wiz under **Settings → Tenant**), e.g. `api.us17.app.wiz.io`.
GraphQL requests go to `https://<host>/graphql`.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `auth_endpoint` | `https://auth.app.wiz.io/oauth/token` | Wiz OAuth2 token endpoint (audience derived from the host). |
| `request_timeout_seconds` | `30` | Per-request timeout for token + GraphQL calls. |

## Development

```
cd apps/wiz
node node_modules/typescript/bin/tsc --noEmit   # typecheck
node ../../scripts/test-apps.mjs wiz            # run handler tests
node ../../scripts/validate-app.mjs apps/wiz    # validate against the app contract
```

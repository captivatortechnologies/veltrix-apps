# Keycloak

Manage [Keycloak](https://www.keycloak.org/) (open-source Identity and Access
Management) **as code**. Author Keycloak **clients** in the Veltrix Configuration
Canvas and drive them through the Security-as-Code pipeline — validate, deploy,
health check, drift detection and rollback — over the **Keycloak Admin REST API**.

- **Category:** IAM
- **App id:** `keycloak`
- **Version:** 0.1.0

## What it manages

| Config type | Keycloak object | API |
| --- | --- | --- |
| **Clients** | OIDC / SAML clients (`clientId`, name, protocol, enabled, public/confidential, standard flow, redirect URIs) | `/admin/realms/{realm}/clients` |

Deploy **upserts by `clientId`** (the client's stable identity): an existing
client is updated in place (`PUT /clients/{id}`), a new one is created
(`POST /clients`). Rollback restores the prior representation, or deletes a client
this app created. Drift compares the declared fields against the live client.

## Authentication

The app talks to the **Admin REST API** at `<host>/admin/realms/{realm}/…` using
an **admin access token** obtained from the OpenID Connect token endpoint:

```
POST <host>/realms/{auth_realm}/protocol/openid-connect/token
```

Two grants are supported:

1. **Client credentials (primary).** An admin **service-account client**. Store
   its **client-id** in the credential `username` and its **client secret** in
   `apiToken`. On that client, enable *Service accounts roles* and assign the
   realm-management role **`manage-clients`** (plus **`view-realm`**) for the
   managed realm.
2. **Password grant (alternative).** An **admin username + password**, exchanged
   against the built-in public `admin-cli` client. Store the username in
   `username` and the password in `password`.

The issued token is sent as `Authorization: Bearer <token>`.

### Connection & settings

A **Connection** carries the Keycloak **base URL** (endpoint) + the admin
credential (client-id + secret). Realm selection lives in **app settings**:

| Setting | Default | Meaning |
| --- | --- | --- |
| `realm` | `master` | The realm whose clients are managed (`{realm}` in the admin paths). |
| `auth_realm` | `master` | The realm that issues the admin token (where the service-account client / admin user lives). Set it to the managed realm if the service-account client is registered there. |
| `verify_tls` | `false` | Enforce a valid TLS certificate. Off by default — self-hosted Keycloak commonly ships a self-signed certificate. |

The **connectivity test** obtains a token and reads the managed realm
(`GET /admin/realms/{realm}`): a 2xx confirms the endpoint resolves, the token was
issued, and it authorizes admin access.

## Endpoints used

| Operation | Method & path |
| --- | --- |
| Obtain admin token | `POST /realms/{auth_realm}/protocol/openid-connect/token` |
| Connectivity / health | `GET /admin/realms/{realm}` |
| Find client by id | `GET /admin/realms/{realm}/clients?clientId={clientId}` |
| Create client | `POST /admin/realms/{realm}/clients` |
| Update client | `PUT /admin/realms/{realm}/clients/{id}` |
| Delete client (rollback) | `DELETE /admin/realms/{realm}/clients/{id}` |

> `{id}` is the client's **internal UUID** (the `id` field of a
> ClientRepresentation), **not** its `clientId`. This app resolves the UUID by
> querying `clients?clientId=…` first.

Sources: the [Keycloak Admin REST API reference](https://www.keycloak.org/docs-api/latest/rest-api/index.html)
and the [server-development guide](https://www.keycloak.org/docs/latest/server_development/index.html#admin-rest-api).

## Accuracy / things to verify against a live Keycloak

The token flow and endpoint paths above are cited directly from the official
docs. The following should be confirmed against a live Keycloak before relying on
them in production:

- The exact **`ClientRepresentation`** field surface (this app authors `clientId`,
  `name`, `protocol`, `enabled`, `publicClient`, `standardFlowEnabled`,
  `redirectUris` and preserves any other fields on update).
- That the admin service-account client has the **`manage-clients`** role on the
  managed realm (create/update/delete otherwise return 403).
- Whether your deployment authenticates against `master` or the managed realm
  itself (set `auth_realm` accordingly).

## Roadmap

- **BYOL infrastructure hosting** — provision and manage a Keycloak stack
  (clustered Keycloak + PostgreSQL) from Veltrix, mirroring the BYOL console other
  apps ship. **Shipped in 0.3.0** — Infrastructure page, `/byol` routes, app-owned
  migrations and usage metering (see the [changelog](CHANGELOG.md)).
- More config types: client scopes, authentication flows, sub-groups.

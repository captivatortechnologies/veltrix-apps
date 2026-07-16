# Proofpoint Essentials (Veltrix app)

Manage **Proofpoint Essentials** email security configuration as code through the
**Essentials Interface API (v1)**. Authoring happens in the Veltrix Configuration
Canvas; every change is applied by the Security-as-Code pipeline (validate →
deploy → health check → drift detect → rollback).

> Scope note: Proofpoint's TAP / SIEM / People / Forensics APIs return **read-only
> threat data**, not configuration. This app deliberately targets only the
> Essentials Interface API, which is a real CRUD configuration surface. It focuses
> on the two cleanest declarative *security-config* surfaces — domains and the
> organization sender lists. (User provisioning, which requires a password on
> create and is unsafe to reconcile declaratively, is intentionally out of scope.)

## Configuration types

| Type | Manages | API | Reconciliation |
| --- | --- | --- | --- |
| **Proofpoint Domains** (`pp-domains`) | Protected domains + inbound mail routing (`is_active`, relay delivery + `destination`, `failovers`) | `/orgs/{org}/domains` (GET/POST/PUT/DELETE) | Upsert keyed on the domain name; domains it didn't declare are never touched |
| **Proofpoint Sender Lists** (`pp-sender-lists`) | Organization Safe (allow) and Blocked (deny) sender entries | The org object `/orgs/{org}` (GET → modify → PUT) | Additive by sender value; rollback removes exactly what deploy added |

## Authentication

Proofpoint Essentials authenticates with an **Organization Admin** or **Channel
Admin** account (which must **not** be read-only). The account's email and
password are sent on every request as the `X-User` and `X-Password` headers.

Store them as a Veltrix connection (Username & password auth):

- **Admin email** (Username) → the admin's full email address
- **Password** → the admin account password
- **Endpoint** → your Essentials data-region stack host, e.g. `us1.proofpointessentials.com` (`us1`–`us5` or `eu1`)

## Setup

1. Create/identify a non-read-only Org/Channel Admin in Proofpoint Essentials.
2. Add a connection with the admin email + password and the stack host as endpoint
   (Connections page), and run the per-row connectivity test.
3. Register a **`proofpoint`** component whose hostname is the stack host, and
   attach the credential.
4. Set the **Organization (primary domain)** app setting to the primary domain of
   the organization you manage (e.g. `acme.com`). All changes apply to
   `/orgs/<that-domain>`.

## Notes

- The base URL is `https://<stack>.proofpointessentials.com/api/v1`.
- Sender lists are attributes of the organization object; the app uses a
  read-modify-write PUT so unrelated org attributes are preserved.
- App settings are only populated in sandbox runs; in production the org is
  resolved from the same setting on the installation — keep the **Organization**
  setting filled in.

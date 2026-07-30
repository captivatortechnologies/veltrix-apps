# Changelog

All notable changes to the Wazuh app are documented here.

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **CDB Lists** config type — manage Wazuh constant databases (`key:value` lookup
  files backing blocklists/allowlists) over the Wazuh REST API (55000), with
  validate / deploy / rollback (prior-body snapshot or delete) / health-check /
  drift-detect / status. Deploy PUTs the raw CDB body to
  `/lists/files/{filename}?overwrite=true`; drift compares live entries key-by-key.
- **Wazuh REST seam** (`lib/wazuhApi.ts`) — self-signed-tolerant `node:https`
  client with the two-step token flow (`/security/user/authenticate` → bearer).
- **Connectivity test** — authenticates against the Wazuh API (HTTPS 55000); a
  returned token means connected, 401 flags the credential.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API user →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for
  the Wazuh manager API).
- **BYOL infrastructure** groundwork — declarative `infra/spec.ts` composing the
  generic OpenTofu modules (`manager-master` / `manager-worker` / `indexer` /
  `dashboard` cluster) + a `wazuh-setup` bring-up entrypoint.

> Wazuh is managed purely over the REST API — there is no Salt/SSH remote-command
> seam. API paths follow Wazuh 4.x conventions and should be verified against your
> build (notably the `/lists/files` octet-stream upload and the GET serialization
> used for the rollback snapshot).

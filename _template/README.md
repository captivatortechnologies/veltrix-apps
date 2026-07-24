# Veltrix App Template

Copy this directory to `apps/<your-app-id>/` and customize. Every Veltrix app follows the same canonical layout — the validator warns on deviations:

```
apps/<app-id>/
├── manifest.yaml                 # The app contract (start here)
├── package.json                  # @veltrixsecops/app-sdk + tooling devDeps
├── tsconfig.json
├── README.md                     # What the app manages, credentials, fields
├── CHANGELOG.md                  # Release notes — REQUIRED on every version bump
├── config-types/<configTypeId>/  # THE unit of extension — everything for one
│   ├── canvas.yaml               #   configuration type in one folder:
│   ├── defaults.yaml             #   form schema, default values,
│   ├── validate.ts               #   and the pipeline handlers
│   ├── deploy.ts
│   ├── rollback.ts
│   ├── healthCheck.ts
│   ├── driftDetect.ts            # optional in the manifest, recommended
│   ├── getStatus.ts
│   ├── options.ts                # optional — live pickers (remote-select/multiselect)
│   ├── testConnection.ts         # optional — the Connections page "Test" button
│   ├── operations/               # optional — one-off actions (restart, rotate, …)
│   └── __tests__/                # Tests live next to the code they cover
├── lib/                          # Shared app code (API client used by all handlers)
├── hooks/                        # Lifecycle hooks (camelCase): onInstall.ts, onUninstall.ts, ...
├── migrations/                   # SQL migrations (only with manifest `database`; tablePrefix enforced)
├── server/index.ts               # Fastify route module (AppRouteContext)
├── client/index.tsx              # Client entry + client/pages/*.tsx (optional)
└── assets/                       # Icons/logos (optional)
```

Adding a configuration type = adding one `config-types/<id>/` folder and one manifest entry.

## Inventory

Every app shares a built-in **Inventory** — the deployment targets it can deploy
configuration to: servers (hostname/port), domains, and IP/CIDR ranges. Inventory
is a typed, convenient surface over the platform's components API, so you don't
plumb `/api/components` by hand. Import the framework-free helpers from
`@veltrixsecops/app-sdk/client`:

```ts
import {
  listInventory,
  addInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  type InventoryItem,
} from '@veltrixsecops/app-sdk/client'

const targets = await listInventory() // InventoryItem[]: hostname, port, domains, ipRanges, tags, ...
```

Each `InventoryItem` carries `hostname`, `port`, `type`, `domains`, `ipRanges`,
`tags`, and `connectivityProviderId`. The helpers use the platform's
authenticated `authFetch` internally and throw an `Error` (with the platform's
message) on any non-2xx response.

This template ships a ready-made `client/pages/AccessServersPage.tsx` (registered
at `/access-servers` in `manifest.yaml`) that lists these deployment targets and
adds servers — each linked to a Connection (credential) and a ZTNA provider —
copy or adapt it. Note: creating a target requires a `toolId` (the tool the
target belongs to); source it from your app before calling `addInventoryItem`.

Quick start:

```bash
npx @veltrixsecops/cli init my-security-tool   # scaffolds this structure
cd my-security-tool
npm install
npm run typecheck
npx veltrix validate .
```

## Facets reference

Every capability below is wired in this template — delete what you don't need.

### Pipeline handlers (`config-types/<id>/`)
Required: `validate`, `deploy`, `rollback`, `healthCheck`, `getStatus`. Recommended:
`driftDetect`. Each is an extensionless manifest path whose default export is the
handler. They run **in-process** on the platform with the decrypted credential.

### Live pickers — `options.ts`
Fields with `fieldType: remote-select` (stores one id) or `remote-multiselect`
(stores `string[]`) + `optionsSource: "<name>"` pull their list from the tool at
edit time. The platform resolves the connection, runs your provider per server,
and **aggregates + de-dupes** across servers. A source can declare which server
roles it pulls from — ordered = fallback — via a `sourceComponentTypes` export,
DECOUPLED from where the config deploys:

```ts
// indexes live on indexers, so pull the list from indexers, else search heads
export const sourceComponentTypes = { indexes: ['indexer', 'search-head'] }
```

### Connectivity & credentials
Handler contexts carry `credential` (decrypted), `connectivity` (legacy direct
record), and `connectivityProvider` (the managed provider). For a **managed-ZTNA**
server there is no direct `connectivity` — reach it via the provider's
`config.deviceAddress` (tailnet host); accept the self-signed cert. When files
must land on the box, `ctx.remote` (a `RemoteExecutor`) exposes `putFile` / `run`
/ `extractArchive` / `hashTree` / `readFile` over the tailnet. Always accept
`connectivity || connectivityProvider` — requiring only `connectivity` breaks
managed hosts.

### Connections page + `testConnection`
The platform provides a `/connections` page (import from
`@veltrixsecops/app-sdk/client`); back its "Test" button with a
`connectivity.testHandler` (see `testConnection.ts`).

### Per-server targeting
`targets.componentTypes` lists the roles a config type CAN deploy to. The operator
picks the **specific** server(s) per-config with the canvas **Target Servers**
picker (there can be several of each role); an empty selection targets all servers
matching `componentTypes`. Deploy, rollback, drift and health all act on exactly
the selected servers.

### Deploy contract
Return `{ success, message, rollbackData }`. Persist an item-id → external-id map
in `rollbackData.resourceIds` and read the last successful deploy via
`ctx.platform.getLatestDeployment()` so a rename UPDATES the same external object
(rename-safety). EVERY strategy (DIRECT/ROLLING/CANARY/BLUE_GREEN) must return
rollbackData.

### Content drift
Beyond state, hash each **file** you shipped vs the live one (`ctx.remote.hashTree`
over ZTNA, else an API fetch). Compare `.conf`/JSON **key by key** on the keys you
shipped and ignore keys the tool adds itself, so bookkeeping doesn't false-alarm.

### Operations
One-off actions (restart, rotate) declared under manifest `operations`, invoked at
`POST /api/apps/<app>/operations/<id>`. See `config-types/configs/operations/`.

### Settings, hooks, events
`settings` (admin-configurable per customer, reach via `ctx.settings`), `hooks`
(`onInstall`/`onUninstall`/`onEvent`/`onWebhook`/`onUpgrade`), and `events`
(platform events your app subscribes to) are all declared in the manifest.

### Theming
UI pages compose from `@veltrixsecops/app-sdk/ui` (`rt.ui`), styled through the
platform's `--color-*` CSS-variable contract (RGB triples) so light/dark and the
tenant brand apply automatically. Use inline SVG icons, not Unicode glyphs.

### Versioning & release notes
Bump `manifest.yaml` **and** `package.json` `version` together, and add a matching
`## <version>` entry to `CHANGELOG.md` — CI fails a version bump without release
notes.

### Testing
Tests live in `__tests__/` next to the code. The app test runner bundles each
`*.test.ts` with esbuild and runs it under `node:test` (jest-style `describe`/`it`/
`expect` globals). Inject a fake HTTP transport rather than hitting a real tool.

```bash
npm run typecheck
node ../../scripts/test-apps.mjs <app-id>     # from the repo root: scripts/test-apps.mjs
npx veltrix validate .
```

See the repo's [CONTRIBUTING.md](../CONTRIBUTING.md) for the full guide, rules, and review process.

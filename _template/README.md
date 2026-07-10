# Veltrix App Template

Copy this directory to `apps/<your-app-id>/` and customize. Every Veltrix app follows the same canonical layout — the validator warns on deviations:

```
apps/<app-id>/
├── manifest.yaml                 # The app contract (start here)
├── package.json                  # @veltrixsecops/app-sdk + tooling devDeps
├── tsconfig.json
├── README.md                     # What the app manages, credentials, fields
├── config-types/<configTypeId>/  # THE unit of extension — everything for one
│   ├── canvas.yaml               #   configuration type in one folder:
│   ├── defaults.yaml             #   form schema, default values,
│   ├── validate.ts               #   and the six pipeline handlers
│   ├── deploy.ts
│   ├── rollback.ts
│   ├── healthCheck.ts
│   ├── driftDetect.ts            # optional in the manifest, recommended
│   ├── getStatus.ts
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

This template ships a ready-made `client/pages/InventoryPage.tsx` (registered at
`/inventory` in `manifest.yaml`) that lists inventory and adds servers — copy or
adapt it. Note: creating a target requires a `toolId` (the tool the target
belongs to); source it from your app before calling `addInventoryItem`.

Quick start:

```bash
npx @veltrixsecops/cli init my-security-tool   # scaffolds this structure
cd my-security-tool
npm install
npm run typecheck
npx veltrix validate .
```

See the repo's [CONTRIBUTING.md](../CONTRIBUTING.md) for the full guide, rules, and review process.

# @veltrixsecops/app-sdk

The official SDK for building [Veltrix](https://veltrixsecops.com) Security-as-Code apps. Community apps live in the open-source [veltrix-apps](https://github.com/captivatortechnologies/veltrix-apps) repository; the Veltrix platform itself is a hosted SaaS.

A Veltrix app packages everything needed to manage one security tool's configuration as code: pipeline handlers (validate → deploy → rollback → health-check → drift-detect → status), canvas templates, database migrations, lifecycle hooks, and optional client pages. This SDK provides the typed contracts and helpers for all of it.

## Installation

```bash
npm install --save-dev @veltrixsecops/app-sdk
```

The SDK is types-first: pipeline handlers typically only need `import type`, so it can be a dev dependency.

## Writing pipeline handlers

Every configuration type your app declares in `manifest.yaml` implements six handlers. Each receives a typed context built by the platform:

```ts
// handlers/indexes/validate.ts
import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors = []
  for (const section of ctx.canvas.sections) {
    if (!section.fields['name']) {
      errors.push({ field: 'name', message: 'Name is required', code: 'required' })
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] }
}
```

Or use the `define*` helpers for inference:

```ts
import { defineDeployer } from '@veltrixsecops/app-sdk/pipeline'

export default defineDeployer(async (ctx) => {
  // ctx.component, ctx.credential, ctx.connectivity, ctx.connectivityProvider
  // ctx.previousConfig, ctx.strategy, ctx.canaryPercent
  return { success: true, message: 'Deployed', rollbackData: {/* prior state */} }
})
```

## Reading platform data

Handlers must never query the platform database directly. Use the tenant-scoped
data API on every context instead:

```ts
import type { PipelineContext, ConfigStatus } from '@veltrixsecops/app-sdk'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const latest = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
  const components = await ctx.platform.listComponents({ types: ['indexer'] })
  // ...
}
```

## Lifecycle hooks

```ts
// hooks/on-install.ts
import type { AppHookContext } from '@veltrixsecops/app-sdk'

export default async function onInstall({ db, appId }: AppHookContext): Promise<void> {
  // Seed your app's own (prefixed) tables here.
}
```

## Client pages

```tsx
import { useAppContext, usePipelineStatus } from '@veltrixsecops/app-sdk/hooks'
```

## Standard app layout

Every Veltrix app follows one canonical folder structure — the CLI scaffolds it (`veltrix init`), `veltrix validate` warns on deviations, and the SDK exports it as constants (`APP_LAYOUT`, `HANDLER_NAMES`, `conventionalPaths(configTypeId)`):

```
apps/<app-id>/
├── manifest.yaml                          # App contract
├── package.json / tsconfig.json / README.md
├── config-types/<configTypeId>/           # Everything for one configuration type:
│   ├── canvas.yaml                        #   form schema
│   ├── defaults.yaml                      #   default values
│   ├── validate.ts, deploy.ts, rollback.ts,
│   ├── healthCheck.ts, driftDetect.ts, getStatus.ts
│   └── __tests__/
├── lib/                                   # Shared app code (API clients)
├── hooks/                                 # onInstall.ts, onUninstall.ts, ...
├── migrations/                            # SQL (with database.tablePrefix)
├── server/index.ts                        # Route module (AppRouteContext)
├── client/index.tsx + client/pages/       # Optional UI
└── assets/                                # Optional icons
```

```ts
import { conventionalPaths } from '@veltrixsecops/app-sdk'
conventionalPaths('indexes').handlers.deploy // 'config-types/indexes/deploy'
```

## Package layout

| Entry point | Contents |
|---|---|
| `@veltrixsecops/app-sdk` | All types: handler contexts/results, manifest, platform refs, hook contexts |
| `@veltrixsecops/app-sdk/pipeline` | `defineValidator`, `defineDeployer`, `defineRollbackHandler`, `defineHealthChecker`, `defineDriftDetector` |
| `@veltrixsecops/app-sdk/hooks` | React hooks for app client pages (requires `react`) |

## Building an app

Community apps live in the [veltrix-apps](https://github.com/captivatortechnologies/veltrix-apps) repository. Start from its [`_template`](https://github.com/captivatortechnologies/veltrix-apps/tree/main/_template) app and see the [contribution guide](https://github.com/captivatortechnologies/veltrix-apps/blob/main/CONTRIBUTING.md).

## License

MIT

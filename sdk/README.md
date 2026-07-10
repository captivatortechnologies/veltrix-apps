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
import { authFetch } from '@veltrixsecops/app-sdk/client'
```

Your `client/index.tsx` default-exports an `AppClientModule` (`{ id, pages, sidebarItems }`;
`pages` keys must match `manifest.client.pages[].component`). At packaging time the CLI
compiles it into a hermetic browser bundle (`client/dist/index.mjs`): `react`, `react-dom`,
`react/jsx-runtime`, and all `@veltrixsecops/app-sdk` imports are replaced with shims that
read the platform-provided runtime from `globalThis.__VELTRIX_APP_RUNTIME__`, so your
components render inside the host React tree with working hooks and shared context — never
bundle your own copy of React.

Two rules for app pages:

- Use **`authFetch`** (not plain `fetch`) for calls to your app's server routes
  (`/api/apps/<app-id>/...`) — they are bearer-token protected and a plain `fetch`
  receives 401s.
- Only import third-party client libraries if you accept them being compiled into your
  bundle; keep pages lean.

### UI components

Build page bodies from the platform's design-system kit instead of hand-rolling raw
HTML. Import from `@veltrixsecops/app-sdk/ui`:

```tsx
import { Button, Card, CardHeader, CardBody, Tabs, DataTable } from '@veltrixsecops/app-sdk/ui'

function Configs() {
  return (
    <Card>
      <CardHeader actions={<Button variant="primary">New</Button>}>Configurations</CardHeader>
      <CardBody>
        <Tabs
          tabs={[
            { key: 'indexes', label: 'Indexes', content: <p>…</p> },
            { key: 'roles', label: 'Roles', content: <p>…</p> },
          ]}
        />
      </CardBody>
    </Card>
  )
}
```

These render in the platform design system and pick up the tenant theme (light/dark) and
your app's branding automatically via the platform's CSS-token bridge — no styling needed.
The bundler shims `@veltrixsecops/app-sdk/ui` to the host's real components, so they share
the single host React instance.

Available components: `Button`, `Input`, `Textarea`, `Checkbox`, `Select`, `Card` (+
`CardHeader`/`CardBody`/`CardFooter`), `Badge`, `Tooltip`, `EmptyState`, `Skeleton` (+
`SkeletonText`/`SkeletonCard`), `DataTable`, `StatsCard`, `FormDialog`, `FormField`, `Tabs`,
`Spinner`. Hooks: `useToast`, `useConfirmDialog`. All prop types are exported alongside the
components.

`useToast` / `useConfirmDialog` are backed by providers the platform mounts around every app
page, so they work with no extra wiring inside Veltrix. Every export is usable outside the
platform too (local dev, tests): components render a minimal, unstyled, accessible fallback,
`useToast` logs to the console, and `useConfirmDialog().confirm()` resolves to `false`
(fails closed) — so nothing crashes, it just runs without platform theming.

## Branding

Declare your vendor identity in the manifest and the platform applies it in defined
slots — the app's navbar (logo + accent color) and scoped CSS variables. The platform
controls where brand color appears, so it stays meaningful rather than theming the shell:

```yaml
branding:
  primaryColor: "#FC0000"     # #RGB or #RRGGBB
  logo: ./assets/logo.svg     # svg (preferred) or png, <=128 KB, ~28px display height
```

In pages, prefer the CSS variables (`--veltrix-app-primary`, `--veltrix-app-accent`);
use `useAppBranding()` from `./hooks` when you need the values programmatically.
SVG logos must not contain scripts or event handlers — the validator rejects them.

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

> **2.0.0 (breaking):** the root entry no longer re-exports the React hooks — import them from
> `@veltrixsecops/app-sdk/hooks`. Pipeline handlers run in a bare Node child process, so the contract
> they import must never pull in React.

| Entry point | Contents |
|---|---|
| `@veltrixsecops/app-sdk` | **React-free.** All types (handler contexts/results, manifest, platform refs, hook contexts), `APP_LAYOUT`/`HANDLER_NAMES`/`conventionalPaths()` — safe to load in a bare Node process, which is what the sandbox runner does |
| `@veltrixsecops/app-sdk/pipeline` | `defineValidator`, `defineDeployer`, `defineRollbackHandler`, `defineHealthChecker`, `defineDriftDetector` |
| `@veltrixsecops/app-sdk/hooks` | React hooks for app client pages (requires `react`) |
| `@veltrixsecops/app-sdk/client` | Browser client contract: `authFetch`, `getHostRuntime`, `AppClientModule` |
| `@veltrixsecops/app-sdk/ui` | Platform design-system components + hooks for app client pages (requires `react`; renders richly inside the platform, degrades to a minimal accessible fallback outside it) |

## Building an app

Community apps live in the [veltrix-apps](https://github.com/captivatortechnologies/veltrix-apps) repository. Start from its [`_template`](https://github.com/captivatortechnologies/veltrix-apps/tree/main/_template) app and see the [contribution guide](https://github.com/captivatortechnologies/veltrix-apps/blob/main/CONTRIBUTING.md).

## License

MIT

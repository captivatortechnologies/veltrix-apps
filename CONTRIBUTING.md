# Contributing Apps to Veltrix

This guide explains how to improve an existing app or create a new one for the Veltrix platform.

## Two ways to contribute

### 1. Improve an existing app

Example: Splunk ships a new release and the index validation rules need updating.

1. Fork this repository and create a feature branch.
2. Make your change under `apps/splunk-enterprise/` (e.g. edit `handlers/indexes/validate.ts`).
3. **Bump `version` in the app's `manifest.yaml`** (semver: patch for fixes, minor for new capability). CI rejects app changes that don't bump the version.
4. Validate locally: `node scripts/validate-app.mjs apps/splunk-enterprise`
5. Open a PR describing what changed and why (link Splunk release notes / use case).

On merge, CI publishes an immutable release `splunk-enterprise-v<new-version>`, updates the marketplace catalog, and every Veltrix instance sees the update.

### 2. Create a new app

1. **Copy the template**: duplicate `_template/` to `apps/<your-app-id>/` (lowercase, hyphens only, e.g. `my-security-tool`).
2. **Edit `manifest.yaml`**: this is your app's contract with the platform. Required fields:
   - `id` — unique slug matching your directory name (`/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`)
   - `name`, `version`, `vendor`, `description`, `category`
   - `pipeline.configurationTypes` — at least one configuration type with handlers
   - `server.entry` — server entry point
3. **Implement pipeline handlers** against [`@veltrixsecops/app-sdk`](https://www.npmjs.com/package/@veltrixsecops/app-sdk). Every configuration type defines:
   - `validate` — validate configuration before deployment
   - `deploy` — apply configuration to target components
   - `rollback` — revert to previous configuration
   - `healthCheck` — verify the deployed configuration is healthy
   - `driftDetect` — (optional) compare live state against deployed config
   - `getStatus` — report current status
4. **Use only the SDK.** Handlers receive everything through their context: `ctx.canvas`, `ctx.component`, `ctx.credential`, `ctx.connectivityProvider`, and the tenant-scoped `ctx.platform` data API. Never import platform internals (`server/src/...`, `@prisma/client`) — CI rejects imports that escape your app directory.
5. **Test locally**:
   ```bash
   cd apps/<your-app-id>
   npm install           # pulls @veltrixsecops/app-sdk + typescript
   npm run typecheck
   cd ../.. && node scripts/validate-app.mjs apps/<your-app-id>
   ```
   The Veltrix platform itself is a hosted SaaS and is not open source yet, so community contributors can't run a full platform locally. The validator + typecheck cover the app contract; end-to-end behavior is exercised by maintainers against a staging tenant during review. (Veltrix team: point the server's `APPS_DIR` at a checkout of this repo's `apps/` directory for live development.)

## Directory structure

```
apps/my-security-tool/
├── manifest.yaml              # App contract (required)
├── package.json               # SDK + tooling devDependencies
├── tsconfig.json
├── server/
│   └── index.ts               # Server entry point & API routes (AppRouteContext)
├── handlers/                  # Pipeline handlers per configuration type
│   └── <configType>/{validate,deploy,rollback,healthCheck,driftDetect,getStatus}.ts
├── hooks/                     # Lifecycle hooks (optional): onInstall, onUninstall, ...
├── migrations/                # Database migrations (optional, tablePrefix enforced)
├── templates/                 # Canvas templates (YAML form schemas)
├── defaults/                  # Default configurations (optional)
├── client/                    # Custom UI pages (optional)
└── assets/                    # Icons, logos (optional)
```

## Submission & review

1. Open a **pull request** targeting `main` with a description of what your app does, which security tools it integrates with, and testing instructions.
2. CI validates automatically: manifest schema, handler completeness, version bump, no executables, size cap, import boundaries, TypeScript compile, secret scan.
3. A maintainer (see `.github/CODEOWNERS`) reviews for code quality and security.
4. On merge, CI packages the app and publishes the release + catalog automatically.

## Remote connectivity (zero-trust access)

The platform provides a **shared remote connectivity system** all apps inherit automatically — you do **not** build your own SSH/VPN/tunnel handling.

1. Admins configure providers (Tailscale, SSH, WireGuard, Cloudflare Tunnel, ZeroTier, Nebula, OpenVPN, AWS SSM, HashiCorp Boundary) in the platform Settings UI.
2. Handlers receive the provider automatically via `ctx.connectivityProvider` when the configuration type sets `requiresConnectivity: true`.

```typescript
if (ctx.connectivityProvider) {
  const { providerType, config } = ctx.connectivityProvider
  switch (providerType) {
    case 'tailscale': /* config.tailnet, config.apiKey — use Tailscale API */ break
    case 'ssh':       /* config.username, config.privateKey, config.port */ break
    case 'wireguard': /* config.endpoint, config.privateKey */ break
    // ... other providers
  }
}
```

| Provider | Type | Config keys |
|----------|------|-------------|
| Tailscale | Mesh VPN | `tailnet`, `apiKey`, `apiUrl` |
| SSH Keys | Traditional | `username`, `privateKey`, `passphrase`, `port`, `jumpHost` |
| WireGuard | Mesh VPN | `privateKey`, `publicKey`, `endpoint`, `allowedIPs` |
| Cloudflare Tunnel | Zero Trust | `tunnelToken`, `accountId`, `tunnelId` |
| ZeroTier | Mesh VPN | `networkId`, `apiToken` |
| Nebula | Mesh VPN | `caCert`, `nodeCert`, `nodeKey`, `lighthouseHost` |
| OpenVPN | Traditional | `serverAddress`, `caCert`, `clientCert`, `clientKey` |
| AWS SSM | Cloud Native | `region`, `accessKeyId`, `secretAccessKey` |
| HashiCorp Boundary | Zero Trust | `boundaryAddr`, `authMethodId`, `loginName`, `password` |

## Rules (enforced by CI)

- **App ID**: must match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` and equal the directory name
- **Version**: semver; must be bumped whenever the app's files change
- **Package size**: maximum 50 MB zipped
- **No executables**: `.sh`, `.bat`, `.exe`, `.cmd`, `.ps1` files are rejected
- **Import boundaries**: no relative imports escaping your app directory; no `@prisma/client` — use `ctx.platform` / `ctx.db` from the SDK
- **Database tables**: `database.tablePrefix` required when using migrations (lowercase, ends with `_`, unique across apps)
- **API routes**: namespaced under `/api/apps/<your-app-id>/`
- **No secrets**: never commit credentials, API keys, or tokens (CI runs a secret scan)

## Questions?

Open an issue — there are templates for app requests and bug reports.

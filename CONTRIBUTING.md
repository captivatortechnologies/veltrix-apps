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
   The validator + typecheck enforce the app contract (the same rules CI runs). For end-to-end behavior, develop against a sandbox in your own tenant — see the next section.

### Develop against your tenant (sandbox dev loop)

The Veltrix platform runs as a hosted SaaS or a self-hostable open-source [Community Edition](https://github.com/captivatortechnologies/veltrix-community). Either way, the recommended app-dev loop is to run your work-in-progress app inside a **sandbox** in your own tenant, synced live from your editor by the [Veltrix CLI](cli/README.md):

```bash
npm install -g @veltrixsecops/cli
veltrix login                                            # API key from Settings → Keys & Tokens
veltrix sandbox create my-tool-dev --app my-security-tool
veltrix dev apps/my-security-tool --sandbox my-tool-dev  # watch + live sync
```

Saves land in the sandbox within a second or two: the platform validates the manifest, transpiles server-side TypeScript, and reports results back to your terminal. Sync is **two-way** — edits made in the portal's in-browser sandbox editor are applied back to your local files (`↓ <path> (from sandbox)`), guarded so neither side clobbers the other's unsaved work; `--no-pull` keeps it one-way and `--force-pull` takes the sandbox version on conflict. Add `--run <configTypeId>:<handler>` to invoke a pipeline handler after each sync, and `--logs` to stream sandbox events when the platform supports it. Sandboxed apps are isolated to your tenant, can only target components an admin tagged for sandbox use, and never receive production credentials.

> Sandbox development requires a tenant with the sandbox feature enabled (`SANDBOX_ENABLED`) and an API key with the `sandbox:read` / `sandbox:write` scopes. If your tenant doesn't have it yet, the validator + typecheck still cover the full app contract, and maintainers exercise end-to-end behavior against a staging tenant during review. (Veltrix team: pointing the server's `APPS_DIR` at a checkout of this repo's `apps/` directory also works for platform-side development.)

## Directory structure (canonical — all apps use this exact layout)

Every app follows one predictable structure. `veltrix init <app-id>` scaffolds it, `veltrix validate` warns on deviations, and the SDK exports it as `APP_LAYOUT`/`conventionalPaths()`:

```
apps/my-security-tool/
├── manifest.yaml                          # App contract (required)
├── package.json                           # SDK + tooling devDependencies
├── tsconfig.json
├── README.md                              # What the app manages + credential setup
├── config-types/<configTypeId>/           # THE unit of extension — everything for
│   ├── canvas.yaml                        #   one configuration type in one folder:
│   ├── defaults.yaml                      #   form schema, default values, and the
│   ├── validate.ts                        #   six pipeline handlers
│   ├── deploy.ts
│   ├── rollback.ts
│   ├── healthCheck.ts
│   ├── driftDetect.ts
│   ├── getStatus.ts
│   └── __tests__/                         # Tests next to the code they cover
├── lib/                                   # Shared app code (API clients, parsers)
├── hooks/                                 # Lifecycle hooks (camelCase): onInstall.ts, ...
├── migrations/                            # SQL migrations (optional, tablePrefix enforced)
├── server/index.ts                        # Route module (AppRouteContext)
├── client/index.tsx + client/pages/       # Custom UI pages (optional)
└── assets/                                # Icons, logos (optional)
```

Adding a configuration type = one new `config-types/<id>/` folder + one manifest entry. Manifest references use the conventional paths, extensionless for code (e.g. `config-types/indexes/deploy`, `config-types/indexes/canvas.yaml`, `hooks/onInstall`).

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
- **Version**: semver; must be bumped whenever the app's files change; `package.json` version must equal `manifest.version`
- **Package size**: maximum 50 MB zipped
- **No executables**: `.sh`, `.bat`, `.exe`, `.cmd`, `.ps1` files are rejected; symlinks are rejected; hidden files are flagged
- **Import boundaries**: no relative imports escaping your app directory; no `@prisma/client` — use `ctx.platform` / `ctx.db` from the SDK
- **In-process safety**: apps run inside the platform server — `child_process`, `vm`, `worker_threads`, `cluster`, `eval()`, `new Function()`, and `process.exit()` are rejected; `fs`/`os` imports are flagged for review
- **Canvas templates**: `canvas.yaml` and `defaults.yaml` are schema-checked (field types, select options, regex validity, defaults matching declared fields)
- **Client bundle**: if the app declares `client.entry`, it must compile with the packager's bundler (`veltrix validate` runs the same dry-run CI does)
- **Database tables**: `database.tablePrefix` required when using migrations (lowercase, ends with `_`, unique across apps)
- **API routes**: namespaced under `/api/apps/<your-app-id>/`
- **No secrets**: never commit credentials, API keys, or tokens (the validator scans for key/token shapes, and CI additionally runs TruffleHog)
- **Reproducible packages**: `veltrix package` is deterministic — the same source always produces the same sha256

### How validation rules evolve

New checks land as **warnings first** and are promoted to errors in a later
release, announced in release notes — mirroring the warn→fail lifecycle
Splunk uses for Cloud vetting checks. Deprecation warnings (like the old
`sidebar:` page flag) always name the replacement. If a check blocks
something you believe is legitimate, open an issue referencing the exact
message; category prefixes (`security:`, `canvas:`, `packaging:`, `client:`,
`settings:`, `layout:`) identify which rule family fired.

## Questions?

Open an issue — there are templates for app requests and bug reports.

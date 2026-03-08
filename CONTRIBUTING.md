# Contributing Apps to Veltrix

This guide explains how to create and submit a community app for the Veltrix platform.

## Getting Started

1. **Copy the template**: Duplicate the `_template/` directory and rename it to your app's slug ID (lowercase, hyphens only, e.g. `my-security-tool`).

2. **Edit `manifest.yaml`**: This is your app's contract with the platform. Required fields:
   - `id` — Unique slug matching your directory name (`/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`)
   - `name`, `version`, `vendor`, `description`, `category`
   - `pipeline.configurationTypes` — At least one configuration type with handlers
   - `server.entry` — Server entry point

3. **Implement pipeline handlers**: Every app must define Security-as-Code handlers:
   - `validate` — Validate configuration before deployment
   - `deploy` — Apply configuration to target components
   - `rollback` — Revert to previous configuration
   - `healthCheck` — Verify the deployed configuration is healthy
   - `getStatus` — Report current status

4. **Test locally**: Place your app directory in `server/src/apps/` and run the server. The AppRegistry will auto-discover it.

## Directory Structure

```
my-security-tool/
├── manifest.yaml              # App contract (required)
├── server/
│   ├── index.ts              # Server entry point & API routes
│   ├── pipeline/             # Pipeline handlers (required)
│   │   ├── configs.validate.ts
│   │   ├── configs.deploy.ts
│   │   ├── configs.rollback.ts
│   │   ├── configs.health-check.ts
│   │   └── configs.status.ts
│   ├── hooks/                # Lifecycle hooks (optional)
│   ├── migrations/           # Database migrations (optional)
│   └── defaults/             # Default configurations (optional)
├── client/                   # Custom UI pages (optional)
│   ├── index.tsx
│   ├── pages/
│   └── canvas-templates/
└── assets/                   # Icons, logos (optional)
```

## Submission Process

1. **Fork** the repository and create a feature branch.
2. **Add your app** under `apps-and-tools/your-app-id/`.
3. **Open a Pull Request** targeting `main` with:
   - Description of what your app does
   - Which security tools it integrates with
   - Testing instructions
4. **Review**: The team will review your app for:
   - Manifest correctness
   - Pipeline handler completeness
   - Security (no path traversal, no executable files)
   - Code quality
5. **Merge**: After approval, merge to `main`. The CI pipeline will automatically:
   - Package your app into a `.zip` archive
   - Upload it as a GitHub release asset under the `apps-latest` tag
   - The download URL becomes: `https://github.com/<org>/Veltrix/releases/download/apps-latest/<app-id>.zip`

## Rules

- **App ID**: Must match `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` (lowercase alphanumeric + hyphens)
- **Package size**: Maximum 50 MB after zipping
- **No executables**: `.sh`, `.bat`, `.exe`, `.cmd`, `.ps1` files are rejected
- **Database tables**: Must be prefixed with `app_<yourprefix>_` to avoid conflicts
- **API routes**: Must be namespaced under `/api/apps/<your-app-id>/`
- **No secrets**: Never commit credentials, API keys, or tokens

## Questions?

Open an issue or reach out to the platform team.

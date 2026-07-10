# Veltrix Community Apps

The official app repository for the [Veltrix Security-as-Code platform](https://github.com/captivatortechnologies/Veltrix).

A **Veltrix app** packages everything needed to manage one security tool's configuration as code: pipeline handlers (validate → deploy → rollback → health-check → drift-detect → status), canvas templates, database migrations, lifecycle hooks, and optional UI pages. Apps in this repository are reviewed, packaged by CI, and installable from the Veltrix marketplace.

> The Veltrix platform itself is a hosted SaaS (open-sourcing is planned, not yet available) — this repository is the platform's open-source surface. Apps are installed by tenants entirely through the platform UI; release packages ship with server-side handlers precompiled to JavaScript so they load at runtime on hosted instances.

## Available apps

| App | Category | Description |
|---|---|---|
| [splunk-enterprise](apps/splunk-enterprise/) | SIEM | Manage Splunk Enterprise configurations as code — indexes, roles, BYOL infrastructure, version tracking |

More integrations (CrowdStrike Falcon, Cortex XSOAR, Elastic Security, HashiCorp Vault, Wiz, Tenable, Okta) are planned — see the issue tracker for app requests, or build one yourself.

## Installing an app

Apps are installed from the **Apps** page of your Veltrix instance — either directly from the marketplace catalog or by URL using a release asset from this repository:

```
https://github.com/captivatortechnologies/veltrix-apps/releases/download/<app-id>-v<version>/<app-id>.zip
```

The marketplace catalog consumed by Veltrix instances is published at:

```
https://captivatortechnologies.github.io/veltrix-apps/catalog.json
```

## Building an app

1. Copy [`_template/`](_template/) to `apps/<your-app-id>/` (lowercase, hyphens).
2. Edit `manifest.yaml` — your app's contract with the platform.
3. Implement the six pipeline handlers against [`@veltrixsecops/app-sdk`](https://www.npmjs.com/package/@veltrixsecops/app-sdk).
4. Validate locally:
   ```bash
   npm ci
   node scripts/validate-app.mjs apps/<your-app-id>
   ```
5. Open a pull request — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and review criteria.

## Release model

- Every merge to `main` that changes an app triggers CI to validate, package, and publish it as an **immutable release** tagged `<app-id>-v<version>` with the ZIP and its SHA-256 checksum as assets.
- Shipping a new version of an app = bump `version` in its `manifest.yaml` (CI enforces this on PRs).
- The marketplace catalog (`catalog.json`) is regenerated on every release and served via GitHub Pages.

## Repository layout

```
apps/<app-id>/     # One directory per app (manifest.yaml + handlers + ...)
_template/         # Starting point for new apps
sdk/               # @veltrixsecops/app-sdk — the typed app contract
cli/               # @veltrixsecops/cli — validate, package, login, (soon) dev
scripts/           # Validation + catalog generation used by CI and locally
catalog/           # Generated marketplace catalog (committed by CI)
.github/workflows/ # PR validation, release packaging, catalog + npm publishing
```

## License

[Apache-2.0](LICENSE). Individual apps may declare their own compatible license in their manifest.

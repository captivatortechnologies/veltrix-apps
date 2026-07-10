# Veltrix App Template

Copy this directory to `apps/<your-app-id>/` and customize. Every Veltrix app follows the same canonical layout — the validator warns on deviations:

```
apps/<app-id>/
├── manifest.yaml                 # The app contract (start here)
├── package.json                  # @veltrixsecops/app-sdk + tooling devDeps
├── tsconfig.json
├── README.md                     # What the app manages, credentials, fields
├── handlers/<configTypeId>/      # Six pipeline handlers per configuration type
│   ├── validate.ts
│   ├── deploy.ts
│   ├── rollback.ts
│   ├── healthCheck.ts
│   ├── driftDetect.ts            # optional in the manifest, recommended
│   └── getStatus.ts
├── templates/<configTypeId>-canvas.yaml   # Configuration Canvas form schema
├── defaults/<configTypeId>.yaml           # Default field values
├── hooks/                        # Lifecycle hooks (camelCase): onInstall.ts, onUninstall.ts, ...
├── migrations/                   # SQL migrations (only with manifest `database`; tablePrefix enforced)
├── server/index.ts               # Fastify route module (AppRouteContext)
├── client/index.tsx              # Client entry + client/pages/*.tsx (optional)
└── assets/                       # Icons/logos (optional)
```

Quick start:

```bash
npx @veltrixsecops/cli init my-security-tool   # scaffolds this structure
cd my-security-tool
npm install
npm run typecheck
npx veltrix validate .
```

See the repo's [CONTRIBUTING.md](../CONTRIBUTING.md) for the full guide, rules, and review process.

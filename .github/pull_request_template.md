## What does this PR do?

<!-- Improving an existing app? Describe the change and link the vendor release notes / use case that motivated it. New app? Describe what security tool it integrates and what its configuration types manage. -->

## Checklist

- [ ] `version` bumped in the app's `manifest.yaml` (required for any app change)
- [ ] `node scripts/validate-app.mjs apps/<app-id>` passes locally
- [ ] `npm run typecheck` passes inside the app directory
- [ ] All imports come from `@veltrixsecops/app-sdk` (no platform internals, no `@prisma/client`)
- [ ] No credentials, API keys, or tokens committed
- [ ] Tested against a Veltrix instance (describe how below)

## Testing instructions

<!-- How did you verify the handlers behave correctly? -->

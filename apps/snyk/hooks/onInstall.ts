import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Snyk is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Snyk] Running install hook for app "${appId}"`)
  console.log(
    '[Snyk] No seeding required. Next steps: register a "snyk-org" component whose hostname is your ' +
      'Snyk region API host (api.snyk.io, api.eu.snyk.io or api.au.snyk.io), store a Snyk service-account ' +
      'token in a credential (API token field), and set the "Organization ID" app setting. Most Snyk ' +
      'configuration is org-scoped.',
  )
}

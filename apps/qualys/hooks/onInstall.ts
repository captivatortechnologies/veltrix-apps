import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Qualys is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Qualys] Running install hook for app "${appId}"`)
  console.log(
    '[Qualys] No seeding required. Next steps: register a "qualys-platform" component whose hostname ' +
      'is your Qualys API server (find it under Help > About, e.g. qualysapi.qg2.apps.qualys.com), and ' +
      'store a Qualys API service-account username + password in a credential (username + password ' +
      'fields). Use an account with API access and a role scoped to what this app manages.',
  )
}

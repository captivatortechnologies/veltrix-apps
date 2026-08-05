import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: OneLogin is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[OneLogin] Running install hook for app "${appId}"`)
  console.log(
    '[OneLogin] No seeding required. Next steps: register an "onelogin-account" component whose ' +
      'hostname is your OneLogin subdomain (e.g. "acme" or "acme.onelogin.com"), and store a OneLogin ' +
      'API Credential\'s Client ID (credential "username") and Client Secret (credential "API token") - ' +
      'create the API credential under Developers > API Credentials in the OneLogin admin console.',
  )
}

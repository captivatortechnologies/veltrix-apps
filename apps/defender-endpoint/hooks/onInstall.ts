import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Defender for Endpoint is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Defender for Endpoint] Running install hook for app "${appId}"`)
  console.log(
    '[Defender for Endpoint] No seeding required. Next steps: create an Entra app registration with ' +
      'the WindowsDefenderATP application permission Ti.ReadWrite.All (admin-consented), store its ' +
      'Client ID (username) + Client Secret (API token) in a credential, register an "mde-tenant" ' +
      'component whose hostname is your Defender API host (api.security.microsoft.com), and set the ' +
      '"Tenant ID" and "Azure Cloud" app settings.',
  )
}

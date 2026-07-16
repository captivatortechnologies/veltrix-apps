import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Microsoft Intune is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Microsoft Intune] Running install hook for app "${appId}"`)
  console.log(
    '[Microsoft Intune] No seeding required. Next steps: create an Entra app registration with the Graph ' +
      'application permission DeviceManagementConfiguration.ReadWrite.All (admin-consented), store its ' +
      'Client ID (username) + Client Secret (API token) in a credential, register an "intune-tenant" ' +
      'component, and set the "Tenant ID" and "Azure Cloud" app settings. The tenant needs an Intune license.',
  )
}

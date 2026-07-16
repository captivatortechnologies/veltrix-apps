import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Microsoft Sentinel is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Microsoft Sentinel] Running install hook for app "${appId}"`)
  console.log(
    '[Microsoft Sentinel] No seeding required. Next steps: create an Entra app registration, grant its ' +
      'service principal the "Microsoft Sentinel Contributor" role scoped to the workspace resource group, ' +
      'store its Client ID (username) + Client Secret (API token) in a credential, register a ' +
      '"sentinel-workspace" component, and set the Tenant ID, Subscription ID, Resource Group, Workspace Name ' +
      'and Azure Cloud app settings.',
  )
}

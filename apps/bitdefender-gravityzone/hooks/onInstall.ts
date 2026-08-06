import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Bitdefender GravityZone is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Bitdefender GravityZone] Running install hook for app "${appId}"`)
  console.log(
    '[Bitdefender GravityZone] No seeding required. Next steps: generate an API key in the GravityZone ' +
      'Control Center under My Account > API keys (scope it to every action category this app needs — ' +
      'Network, Policy, Packages, Companies, Accounts, Push notifications, Integrations, General); store ' +
      'it in a credential\'s "API token" field; and register a "gravityzone-tenant" component whose ' +
      'hostname is your Control Center API host (e.g. cloud.gravityzone.bitdefender.com). The app ' +
      'authenticates with that key over HTTP Basic (the key as username, an empty password).',
  )
}

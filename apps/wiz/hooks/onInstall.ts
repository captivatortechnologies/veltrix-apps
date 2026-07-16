import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Wiz is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Wiz] Running install hook for app "${appId}"`)
  console.log(
    '[Wiz] No seeding required. Next steps: create a service account in Wiz (Settings > Service Accounts) ' +
      'with the API scopes this app needs (read + create/update/delete for service accounts and cloud ' +
      'configuration rules); store its Client ID in a credential\'s "username" field and its Client Secret ' +
      'in the "API token" field; and register a "wiz-tenant" component whose hostname is your regional Wiz ' +
      'API host (e.g. api.us17.app.wiz.io).',
  )
}

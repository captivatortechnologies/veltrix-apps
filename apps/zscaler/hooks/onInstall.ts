import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Zscaler is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Zscaler] Running install hook for app "${appId}"`)
  console.log(
    '[Zscaler] No seeding required. Next steps: create an API client in the Zidentity Admin portal ' +
      'and store its Client ID in a credential\'s "username" field and its Client Secret in the "API ' +
      'token" field; register a "zscaler-tenant" component whose hostname is your Zidentity vanity ' +
      'domain; and for ZPA config set the "ZPA Customer ID" app setting.',
  )
}

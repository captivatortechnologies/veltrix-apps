import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Exabeam is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Exabeam] Running install hook for app "${appId}"`)
  console.log(
    '[Exabeam] No seeding required. Next steps: register an "exabeam-tenant" component (hostname is ' +
      'informational only), attach a credential holding an Exabeam API Key ("username") and its ' +
      'Secret ("API token") - create one under Settings > API Keys in the Exabeam console - and set ' +
      "the app's Region setting to match your tenant's provisioned New-Scale platform region.",
  )
}

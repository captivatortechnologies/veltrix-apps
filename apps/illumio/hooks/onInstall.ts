import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Illumio is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[${appId}] App installed successfully`)
  console.log(
    `[${appId}] No seeding required. Next steps: in the PCE, create an API key (Settings > API Keys, or a ` +
      'personal API key) with the "labels" scope; store its key as the credential username and its secret as ' +
      'the API key secret; set the PCE host, port and organization ID in this app\'s settings; and register an ' +
      '"illumio-pce" component so deploys have a target.',
  )
}

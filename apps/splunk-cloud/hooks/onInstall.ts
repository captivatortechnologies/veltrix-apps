import type { AppHookContext } from '@veltrixsecops/app-sdk'

/**
 * Install hook for the Splunk Cloud Platform app.
 *
 * The app is stateless on the platform side — all managed state lives in
 * Splunk Cloud behind the ACS API — so no database seeding is required.
 */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Splunk Cloud] Running install hook for app "${appId}"`)
  console.log(
    '[Splunk Cloud] No seeding required. Next steps: register a "splunk-cloud-stack" component ' +
      'whose hostname is the stack name, and store an ACS JWT in a credential\'s "API token" field.',
  )
}

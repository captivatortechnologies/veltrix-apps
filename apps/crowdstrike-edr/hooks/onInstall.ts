import type { AppHookContext } from '@veltrixsecops/app-sdk'

/**
 * Install hook for the CrowdStrike Falcon app.
 *
 * The app is stateless on the platform side — all managed state lives in
 * the Falcon tenant behind the CrowdStrike APIs — so no database seeding
 * is required.
 */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[CrowdStrike Falcon] Running install hook for app "${appId}"`)
  console.log(
    '[CrowdStrike Falcon] No seeding required. Next steps: register a "falcon-tenant" component ' +
      'whose hostname is the Falcon cloud region (us-1, us-2, eu-1, us-gov-1, us-gov-2) or API hostname, ' +
      'and store an API client ID in a credential\'s "username" field with the client secret ' +
      'in the "API token" field.',
  )
}

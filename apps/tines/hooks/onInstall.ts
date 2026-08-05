import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Tines is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Tines] Running install hook for app "${appId}"`)
  console.log(
    '[Tines] No seeding required. Next steps: create an API key in the Tines web app and store it ' +
      'in a credential\'s "API token" field; register a "tines-tenant" component whose hostname is ' +
      'your Tines tenant domain (e.g. acme.tines.com) and attach the credential. The app reaches ' +
      'https://<tenant-domain>/api/v1 with "Authorization: Bearer <key>".',
  )
}

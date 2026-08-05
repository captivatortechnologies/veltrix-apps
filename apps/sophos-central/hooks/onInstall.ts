import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Sophos Central is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Sophos Central] Running install hook for app "${appId}"`)
  console.log(
    '[Sophos Central] No seeding required. Next steps: create a TENANT-level service principal in Sophos ' +
      'Central Admin (Global Settings > API Credentials — see https://developer.sophos.com/getting-started-tenant); ' +
      'store the Client ID in a credential\'s "username" field and the Client Secret in its "API token" field; ' +
      'and register a "sophos-tenant" component. The app authenticates via OAuth2 client credentials and resolves ' +
      'your tenant\'s data-region API host automatically via the Who-Am-I API.',
  )
}

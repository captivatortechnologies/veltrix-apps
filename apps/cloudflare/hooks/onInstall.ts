import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Cloudflare is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cloudflare] Running install hook for app "${appId}"`)
  console.log(
    '[Cloudflare] No seeding required. Next steps: create a scoped API token in the Cloudflare ' +
      'dashboard (My Profile > API Tokens) and store it in a credential\'s "API token" field; register ' +
      'a "cloudflare-zone" component whose hostname is the zone (apex) domain; and for account-scoped ' +
      'types (Access, Gateway, Lists) set the "Account ID" app setting if no zone is registered.',
  )
}

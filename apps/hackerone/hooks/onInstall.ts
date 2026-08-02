import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: HackerOne is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[HackerOne] Running install hook for app "${appId}"`)
  console.log(
    '[HackerOne] No seeding required. Next steps: create an API token in HackerOne ' +
      '(Organization Settings > API Tokens), then on the Connections page store the token ' +
      'IDENTIFIER in the "API username" field and the token VALUE in the "API token" field. ' +
      'Saving the connection also registers the HackerOne API as a deploy target.',
  )
}

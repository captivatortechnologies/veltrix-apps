import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: 1Password is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[1Password] Running install hook for app "${appId}"`)
  console.log(
    '[1Password] No seeding required. Next steps: deploy a 1Password SCIM Bridge (self-hosted - see ' +
      'support.1password.com/scim/), register an "onepassword-scim-bridge" component whose hostname is ' +
      'the bridge\'s base URL (e.g. "https://scim.example.com"), and store the bridge\'s bearer token in ' +
      'the connection\'s "API token" field.',
  )
}

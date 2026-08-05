import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Teleport is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Teleport] Running install hook for app "${appId}"`)
  console.log(
    '[Teleport] No seeding required. Next steps: register a "teleport-cluster" component whose hostname ' +
      'is the Teleport Proxy address (e.g. teleport.example.com:443), and store a local automation user\'s ' +
      'username (credential "Username") and password + TOTP seed bundle (credential "API token") - see the ' +
      "Setup Guide page for the exact JSON bundle shape and how to enroll the user's TOTP device.",
  )
}

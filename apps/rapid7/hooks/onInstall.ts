import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Rapid7 InsightVM is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Rapid7 InsightVM] Running install hook for app "${appId}"`)
  console.log(
    '[Rapid7 InsightVM] No seeding required. Next steps: register an "insightvm-console" component ' +
      'whose hostname is your Security Console host (e.g. console.example.com:3780), and store a ' +
      'console service-account username + password in a credential (username + password fields). ' +
      'Use a non-2FA account with a role scoped to what this app manages.',
  )
}

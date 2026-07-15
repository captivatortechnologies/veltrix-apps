import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: SentinelOne is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[SentinelOne] Running install hook for app "${appId}"`)
  console.log(
    '[SentinelOne] No seeding required. Next steps: create a service-user API token in the ' +
      'SentinelOne console (Settings > Users) scoped at the level you manage, store it in a ' +
      'credential\'s "API token" field; register a "sentinelone-console" component whose hostname is ' +
      'your management console URL (e.g. acme.sentinelone.net); and set the "Scope" and "Scope ID" ' +
      'app settings.',
  )
}

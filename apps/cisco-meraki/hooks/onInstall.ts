import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Cisco Meraki is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cisco Meraki] Running install hook for app "${appId}"`)
  console.log(
    '[Cisco Meraki] No seeding required. Next steps: generate a Dashboard API key in Meraki ' +
      '(Organization > Settings > Dashboard API access, then your admin profile\'s "Generate new API key"); ' +
      'store it in a credential\'s "API token" field; and register a "meraki-organization" component ' +
      '(the hostname is just a label for the organization — the API base is fixed at api.meraki.com).',
  )
}

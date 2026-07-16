import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Cortex XSOAR is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cortex XSOAR] Running install hook for app "${appId}"`)
  console.log(
    '[Cortex XSOAR] No seeding required. Next steps: create an API key in Cortex XSOAR ' +
      '(Settings > Integrations > API Keys) and store it in a credential\'s "API token" field; register an ' +
      '"xsoar-server" component whose hostname is your XSOAR server FQDN (or, for XSOAR 8, the Cortex API ' +
      'gateway host). For Cortex XSOAR 8 / the Cortex platform, also set the "API Key ID" (auth_id) app setting.',
  )
}

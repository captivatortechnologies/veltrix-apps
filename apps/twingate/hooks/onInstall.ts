import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Twingate is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Twingate] Running install hook for app "${appId}"`)
  console.log(
    '[Twingate] No seeding required. Next steps: generate an API token in the Twingate Admin Console ' +
      '(Settings > API > Generate Token); store it in a connection\'s "API token" field; and register a ' +
      '"twingate-network" component (or save it via the Connections page) whose hostname is your Twingate ' +
      'network name, e.g. "acme" or "acme.twingate.com".',
  )
}

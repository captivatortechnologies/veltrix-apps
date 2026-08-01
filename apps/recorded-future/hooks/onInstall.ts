import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Recorded Future is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Recorded Future] Running install hook for app "${appId}"`)
  console.log(
    '[Recorded Future] No seeding required. Next steps: register a "recorded-future-cloud" component ' +
      '(endpoint api.recordedfuture.com by default), and store a List-API-scoped API token as a ' +
      'credential (in the token field). The Connections page does both when you save a connection.',
  )
}

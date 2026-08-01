import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Trend Vision One is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Trend Vision One] Running install hook for app "${appId}"`)
  console.log(
    '[Trend Vision One] No seeding required. Next steps: register a "trend-vision-one-tenant" component ' +
      'whose hostname is your regional API host (e.g. api.xdr.trendmicro.com for the US, ' +
      'api.eu.xdr.trendmicro.com for Europe), and store a Trend Vision One API key (Administration > ' +
      'API Keys) as a credential in the token field.',
  )
}

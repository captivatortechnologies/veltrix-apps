import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Kandji is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Kandji] Running install hook for app "${appId}"`)
  console.log(
    '[Kandji] No seeding required. Next steps: generate an API token in the Kandji web app ' +
      '(Settings > Access > API Token), store it in a credential\'s "API token" field, and save a ' +
      'Connection whose endpoint is your Kandji tenant API URL (e.g. yourcompany.api.kandji.io for US, ' +
      'yourcompany.api.eu.kandji.io for EU) — see the Setup Guide page for details.',
  )
}

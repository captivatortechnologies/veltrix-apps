import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Orca Security is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Orca Security] Running install hook for app "${appId}"`)
  console.log(
    '[Orca Security] No seeding required. Next steps: create an API token in Orca ' +
      '(Settings > Users & Permissions > API > Add API Token); store it in a credential\'s ' +
      '"API token" field; and register an "orca-tenant" component whose hostname is your regional ' +
      'Orca API host (api.orcasecurity.io for US, api.eu.orcasecurity.io for EU).',
  )
}

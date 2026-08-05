import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Cato Networks is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cato Networks] Running install hook for app "${appId}"`)
  console.log(
    '[Cato Networks] No seeding required. Next steps: register a "cato-account" component whose hostname ' +
      'is your Cato Account ID (Cato Management Application, top-right account switcher, or ' +
      'Administration > API Keys), and store a Cato API Key (Administration > API Keys > + New) as the ' +
      'connection\'s "API token".',
  )
}

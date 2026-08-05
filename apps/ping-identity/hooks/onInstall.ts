import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: PingOne is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Ping Identity] Running install hook for app "${appId}"`)
  console.log(
    '[Ping Identity] No seeding required. Next steps: register a "pingone-environment" component ' +
      'whose hostname is the PingOne Environment ID (Environments > <env> > Properties), and store a ' +
      "PingOne worker application's Client ID (credential \"username\") and Client Secret " +
      '(credential "API token") - create the worker app under Applications > Applications > ' +
      '+ Add Application > Worker in the PingOne admin console.',
  )
}

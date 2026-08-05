import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: F5 Distributed Cloud is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[F5 Distributed Cloud] Running install hook for app "${appId}"`)
  console.log(
    '[F5 Distributed Cloud] No seeding required. Next steps: register an "f5xc-namespace" component ' +
      'whose hostname is your tenant console hostname (e.g. "acmecorp.console.ves.volterra.io"), and ' +
      'store an F5 XC API Token credential (credential "API token" field) - create one under ' +
      'Console > Administration > Personal Management > Credentials > Add Credentials > API Token.',
  )
}

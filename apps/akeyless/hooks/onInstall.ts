import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Akeyless is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Akeyless] Running install hook for app "${appId}"`)
  console.log(
    '[Akeyless] No seeding required. Next steps: register an "akeyless-account" component whose ' +
      'hostname is "api.akeyless.io" (the public SaaS control plane) or a private Akeyless Gateway URL, ' +
      'and store an Akeyless API Key auth method\'s Access ID (credential "username") and Access Key ' +
      '(credential "API token") - create the API Key auth method under Auth Methods -> New in the ' +
      'Akeyless Console.',
  )
}

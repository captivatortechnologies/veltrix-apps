import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Proofpoint is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Proofpoint] Running install hook for app "${appId}"`)
  console.log(
    '[Proofpoint] No seeding required. Next steps: store an Organization/Channel Admin email + ' +
      'password in a credential (Username & password auth — the account must not be read-only); ' +
      'register a "proofpoint" component whose hostname is your Essentials stack host (e.g. ' +
      'us1.proofpointessentials.com); and set the "Organization (primary domain)" app setting to the ' +
      "organization's primary domain (e.g. acme.com).",
  )
}

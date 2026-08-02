import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Jamf is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Jamf] Running install hook for app "${appId}"`)
  console.log(
    '[Jamf] No seeding required. Next steps: create an API-only account in Jamf Pro ' +
      '(Settings > System > User Accounts & Groups > New) with a privilege set granting ' +
      'Read/Create/Update/Delete Scripts; store its username in a credential\'s "username" field and its ' +
      'password in the "password" field; and register a "jamf-pro-server" component whose hostname is your ' +
      'Jamf Pro server (e.g. yourcompany.jamfcloud.com, or an on-prem FQDN).',
  )
}

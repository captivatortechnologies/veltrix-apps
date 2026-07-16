import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: CyberArk PAM is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[CyberArk PAM] Running install hook for app "${appId}"`)
  console.log(
    '[CyberArk PAM] No seeding required. Next steps: register a "cyberark-pvwa" component whose ' +
      'hostname is your PVWA web server (e.g. pvwa.example.com), and store a manager service-account ' +
      'username + password in a credential (username + password fields). Scope its Vault ' +
      'authorizations to the safes/accounts this app manages, and choose the auth method (CyberArk, ' +
      'LDAP or RADIUS) in the app settings.',
  )
}

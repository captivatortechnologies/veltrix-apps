import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Cisco Secure Firewall (FMC) is a pure passthrough - no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cisco Secure Firewall] Running install hook for app "${appId}"`)
  console.log(
    '[Cisco Secure Firewall] No seeding required. Next steps: register an "fmc" component whose hostname is ' +
      'the FMC management address (e.g. fmc.example.com), and store an FMC user\'s username/password as the ' +
      'credential - see the Setup Guide page for the required role and deploy ordering (objects -> groups -> ' +
      'access control policies -> access rules).',
  )
}

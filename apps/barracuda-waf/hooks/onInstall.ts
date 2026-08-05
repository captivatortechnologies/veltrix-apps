import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Barracuda WAF-as-a-Service is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Barracuda WAF-as-a-Service] Running install hook for app "${appId}"`)
  console.log(
    '[Barracuda WAF-as-a-Service] No seeding required. Next steps: store the Barracuda Cloud Control ' +
      'admin email + password in a credential (Username & password auth); register a "barracuda-waf" ' +
      'component whose hostname is the exact Application name shown under Applications in the ' +
      'WAF-as-a-Service console; and attach the credential to it.',
  )
}

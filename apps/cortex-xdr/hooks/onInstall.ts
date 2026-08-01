import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Cortex XDR is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cortex XDR] Running install hook for app "${appId}"`)
  console.log(
    '[Cortex XDR] No seeding required. Next steps: register a "cortex-xdr-tenant" component whose ' +
      'hostname is your tenant API FQDN (Settings > Configurations > API Keys > Copy URL, e.g. ' +
      'api-yourtenant.xdr.us.paloaltonetworks.com), and store a Standard-security API key as a ' +
      'credential (API Key ID in the username field, API Key in the token field).',
  )
}

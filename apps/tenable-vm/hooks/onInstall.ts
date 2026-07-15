import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Tenable VM is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Tenable VM] Running install hook for app "${appId}"`)
  console.log(
    '[Tenable VM] No seeding required. Next steps: register a "tenable-vm-tenant" component ' +
      '(hostname defaults to cloud.tenable.com; set it only for a dedicated/FedRAMP host), and ' +
      'store a Tenable API access key in a credential\'s "username" field with the secret key ' +
      'in the "API token" field (Settings > My Account > API Keys in Tenable VM).',
  )
}

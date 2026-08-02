import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook — no seed data required for v0.1.0. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[pfSense] install hook for app "${appId}"`)
  console.log(
    '[pfSense] No seeding required. Next steps: install the pfSense REST API package ' +
      '(pfSense-pkg-RESTAPI — System > Package Manager > Available Packages > search "RESTAPI") on the ' +
      'target firewall if it is not already present, generate an API key or note a local webConfigurator ' +
      'administrator username/password, store it as a credential, and register the firewall as a connection.',
  )
}

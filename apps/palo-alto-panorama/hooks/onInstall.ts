import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Palo Alto Panorama is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Palo Alto Panorama] Running install hook for app "${appId}"`)
  console.log(
    '[Palo Alto Panorama] No seeding required. Next steps: register a "panorama" component whose ' +
      'hostname is your Panorama management host (e.g. panorama.example.com), and store a pre-generated ' +
      'PAN-OS API key in a credential (API token field). Set the device_group app setting to the target ' +
      'device group (or leave "shared"), and rest_api_version to match the box (default v11.0).',
  )
}

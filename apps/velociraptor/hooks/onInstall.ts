import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook — no seed data required for v0.1.0. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Velociraptor] install hook for app "${appId}"`)
}

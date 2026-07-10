import type { AppHookContext } from '@veltrixsecops/app-sdk'

/**
 * Uninstall hook for the CrowdStrike Falcon app.
 *
 * Nothing to clean up: the app keeps no platform-side state, and objects it
 * manages in the Falcon tenant (host groups, prevention policies, custom
 * IOCs) are intentionally left untouched on uninstall.
 */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[CrowdStrike Falcon] Running uninstall hook for app "${appId}"`)
  console.log('[CrowdStrike Falcon] No platform-side state to remove.')
}

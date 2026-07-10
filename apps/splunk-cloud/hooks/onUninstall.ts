import type { AppHookContext } from '@veltrixsecops/app-sdk'

/**
 * Uninstall hook for the Splunk Cloud Platform app.
 *
 * Nothing to clean up: the app keeps no platform-side tables, and resources
 * created on Splunk Cloud (indexes, HEC tokens, IP allow lists) are
 * intentionally left untouched — uninstalling the management plane must
 * never destroy production data.
 */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Splunk Cloud] Running uninstall hook for app "${appId}"`)
  console.log('[Splunk Cloud] Uninstall complete. Splunk Cloud resources were left untouched.')
}

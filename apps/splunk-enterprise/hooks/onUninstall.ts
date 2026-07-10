import type { AppHookContext } from '@veltrixsecops/app-sdk'

/**
 * Uninstall hook for Splunk Enterprise app.
 * Cleans up app-specific data. Preserves audit trail.
 */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Splunk Enterprise] Running uninstall hook for app "${appId}"`)
  // Note: Customer-specific data (indexes, roles, BYOL) is preserved
  // to allow re-installation without data loss.
  // Only remove app-level metadata if needed.
  console.log(`[Splunk Enterprise] Uninstall complete. Customer data preserved.`)
}

import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Uninstall hook — app tables (prefix fleet_) are left intact for audit retention. */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Fleet] uninstall hook for app "${appId}"`)
}

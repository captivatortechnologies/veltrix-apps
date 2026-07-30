import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Uninstall hook — app tables (prefix misp_) are left intact for audit retention. */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[MISP] uninstall hook for app "${appId}"`)
}

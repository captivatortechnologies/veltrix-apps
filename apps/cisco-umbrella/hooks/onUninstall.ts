// Called when the app is being uninstalled.
// Clean up any resources, but DO NOT drop tables by default.

import type { AppHookContext } from '@veltrixsecops/app-sdk'

export default async function onUninstall(ctx: AppHookContext): Promise<void> {
  console.log(`[${ctx.appId}] App uninstalled`)
}

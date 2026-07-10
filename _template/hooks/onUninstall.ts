// Called when the app is being uninstalled.
// Clean up any resources, but DO NOT drop tables by default.
// The platform will ask the user if they want to remove data.

import type { AppHookContext } from '@veltrixsecops/app-sdk'

export default async function onUninstall(ctx: AppHookContext): Promise<void> {
  console.log(`[${ctx.appId}] App uninstalled`)
}

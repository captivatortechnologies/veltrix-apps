// Called when the app is first installed.

import type { AppHookContext } from '@veltrixsecops/app-sdk'

export default async function onInstall(ctx: AppHookContext): Promise<void> {
  console.log(`[${ctx.appId}] App installed successfully`)
}

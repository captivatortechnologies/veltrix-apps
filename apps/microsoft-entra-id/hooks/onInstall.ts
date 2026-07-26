// Called when the app is first installed.
// Use this for database seeding, initial setup, etc.

import type { AppHookContext } from '@veltrixsecops/app-sdk'

export default async function onInstall(ctx: AppHookContext): Promise<void> {
  console.log(`[${ctx.appId}] App installed successfully`)
  // Example: Seed default data
  // await ctx.db.$executeRawUnsafe('INSERT INTO ...')
}

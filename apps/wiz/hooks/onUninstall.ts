import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Uninstall hook: nothing to clean up — the app owns no platform-side state. */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Wiz] Running uninstall hook for app "${appId}"`)
}

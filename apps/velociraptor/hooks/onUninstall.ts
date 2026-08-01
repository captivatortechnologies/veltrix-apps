import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Uninstall hook — nothing to tear down for v0.1.0 (no app tables). */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Velociraptor] uninstall hook for app "${appId}"`)
}

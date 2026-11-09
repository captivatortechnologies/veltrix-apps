import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Uninstall hook: the platform drops the app database; cloud resources are never touched. */
export default async function onUninstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[cloud-governance] Uninstalled "${appId}". Policies and run history are removed with the app database; ` +
    'no cloud resource is changed by uninstalling.')
}

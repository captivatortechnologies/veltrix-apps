import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: tables come from migrations; nothing to seed. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[cloud-governance] Installed "${appId}". Next: add an AWS account under Accounts (account id, ` +
    'role ARN the Veltrix runner may assume, External ID), then author a policy and request a preview run.')
}

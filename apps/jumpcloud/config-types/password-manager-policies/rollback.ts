import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import type { PasswordManagerPolicyRollbackData } from './deploy'

const PATH = '/passwordmanager/company/policies'

/**
 * Restore the Password Manager organization policy's prior `disableExport`
 * value, captured in rollbackData by deploy. Applied over the JumpCloud API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = ctx.rollbackData as PasswordManagerPolicyRollbackData | undefined
  if (!data?.id) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  try {
    const res = await client.request('PUT', `${PATH}/${encodeURIComponent(data.id)}`, {
      query: { disableExport: data.priorDisableExport },
    })
    if (!res.ok) throw new Error(jumpCloudErrorMessage(res))

    return { success: true, message: `Restored Password Manager vault export to ${data.priorDisableExport ? 'disabled' : 'allowed'}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

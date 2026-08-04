import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import type { EmailTaggingRollbackData } from './deploy'

/**
 * Roll back the Email Tagging Settings singleton by PUTting back the exact
 * settings captured before this deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as EmailTaggingRollbackData | undefined
  if (!data?.priorBody) {
    return { success: true, message: 'Nothing to roll back — no prior email-tagging settings were captured.' }
  }

  try {
    const res = await client.request('PUT', `${client.orgPath}/email-tagging`, { body: data.priorBody })
    if (!res.ok) throw new Error(`Failed to restore email-tagging settings: ${ppErrorMessage(res)}`)

    return { success: true, message: 'Rolled back the email-tagging settings to their prior values.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

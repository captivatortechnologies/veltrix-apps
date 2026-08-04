import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import type { ExemptionRollbackData } from './deploy'

/**
 * Roll back email-tagging exemptions using the state captured during deploy:
 * DELETE exactly the senders this deploy added (see validate.ts for the
 * documented inference about DELETE's request body — it accepts the same
 * `{ exemptions: [...] }` shape used by GET/POST).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const added = (ctx.rollbackData as ExemptionRollbackData | undefined)?.added ?? []
  if (added.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy added no email-tagging exemptions.' }
  }

  try {
    const res = await client.request('DELETE', `${client.orgPath}/email-tagging/exemptions`, { body: { exemptions: added } })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to remove email-tagging exemptions: ${ppErrorMessage(res)}`)
    }

    return { success: true, message: `Rolled back ${added.length} email-tagging exemption(s): ${added.join(', ')}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

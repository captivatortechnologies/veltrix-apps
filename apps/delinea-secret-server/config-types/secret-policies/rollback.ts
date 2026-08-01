import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { buildPolicyRestoreBody } from './_shared'
import type { PolicyRollbackEntry } from './deploy'

/**
 * Undo a secret-policies deploy from rollbackData.previous (written by deploy()):
 * for each policy that already existed, PATCH /secret-policy/{id} to restore its
 * prior body; a newly created policy (existed=false) is left in place — this app
 * does not delete policies. Applied over the Secret Server REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PolicyRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let left = 0
  try {
    for (const entry of previous) {
      if (!entry.existed || !entry.prior || entry.policyId === null) {
        // A newly created policy (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      const res = await client.request('PATCH', `/secret-policy/${entry.policyId}`, { body: buildPolicyRestoreBody(entry.prior) })
      if (!res.ok) throw new Error(`Failed to restore secret policy "${entry.secretPolicyName}": ${secretServerErrorMessage(res)}`)
      restored++
    }
    return { success: true, message: `Rolled back secret policies: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

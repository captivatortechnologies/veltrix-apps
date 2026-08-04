import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import { policyIdentityPath } from '../../lib/deployments'
import type { AssignmentRollbackEntry } from './deploy'

/**
 * Undo a policy-assignments deploy from rollbackData.entries:
 *   added (existed false):     unassign the identity from the policy.
 *   already assigned (existed true): leave it — it predates this deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const data = ctx.rollbackData as { entries?: AssignmentRollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const failures: string[] = []
  let unassigned = 0
  const untouched = entries.filter((e) => e.existed).length

  for (const e of entries) {
    if (e.existed) continue
    const res = await client.delete(policyIdentityPath(e.policyId, e.originId))
    if (!res.ok && res.status !== 404) {
      failures.push(`unassign "${e.identityName}" from ${e.policyType} policy "${e.policyName}": ${umbrellaErrorMessage(res)}`)
    } else {
      unassigned++
    }
  }

  if (failures.length) return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  const untouchedSuffix = untouched ? ` ${untouched} pre-existing assignment(s) predated this deploy and were left in place.` : ''
  return { success: true, message: `Rolled back policy assignments: ${unassigned} unassigned.${untouchedSuffix}` }
}

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient } from '../../lib/akamaiApi'
import { policyPath, policyVersionPath } from './_shared'

/**
 * Undo a Cloudlets Policies deploy from rollbackData.previous (written by
 * deploy()):
 *   - a policy that PRE-EXISTED → restore its prior groupId/description (PUT),
 *     and delete the version this deploy created (DELETE), if any.
 *   - a policy we CREATED (existed === false) → delete the whole policy
 *     (DELETE), which also removes the version created with it.
 *
 * Deleting a policy or a version fails if it is active/activating on either
 * network — that failure surfaces as a rollback error (this config type never
 * activates; see cloudlets-policy-activation) rather than being silently
 * forced through, the same honesty Cisco Meraki's Group Policies rollback
 * documents for its own delete step.
 */

interface PriorEntry {
  name: string
  policyId: number | null
  existed: boolean
  priorGroupId: number | null
  priorDescription: string | null
  createdVersion: number | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.policyId == null) {
        skipped++
        continue
      }

      if (!entry.existed) {
        const res = await client.request('DELETE', policyPath(entry.policyId))
        if (!res.ok && res.status !== 404) throw new Error(`DELETE policy "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        deleted++
        continue
      }

      if (entry.createdVersion != null) {
        const res = await client.request('DELETE', policyVersionPath(entry.policyId, entry.createdVersion))
        if (!res.ok && res.status !== 404) {
          throw new Error(`DELETE version ${entry.createdVersion} for "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
      }

      if (entry.priorGroupId != null) {
        const res = await client.request('PUT', policyPath(entry.policyId), {
          body: { groupId: entry.priorGroupId, description: entry.priorDescription || undefined },
        })
        if (!res.ok) throw new Error(`PUT policy "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
      }
      restored++
    }

    return {
      success: true,
      message: `Rolled back Cloudlets policies: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

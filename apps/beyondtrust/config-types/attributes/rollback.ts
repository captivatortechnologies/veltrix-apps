import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, withSession } from '../../lib/beyondtrustApi'

/**
 * Undo an attributes deploy from rollbackData.previous (written by deploy()):
 * DELETE /Attributes/{id} for every attribute VALUE this deploy created.
 * Attributes that already existed (action 'existing') are left as-is.
 * Attribute TYPES this deploy created are NEVER deleted here — DELETE
 * /AttributeTypes/{id} cascades to every attribute under that type, which may
 * include values created by a different deploy or already in use for Smart
 * Rule scoping; this reports which types were created so an operator can
 * remove them in the BeyondInsight console if genuinely unused. A value delete
 * that fails is skipped rather than failing the whole rollback. Applied over
 * the BeyondInsight REST API inside a PS-Auth session.
 *
 * NOTE: verify DELETE /Attributes/{id} against a live BeyondTrust instance.
 */
interface RollbackEntry {
  attributeTypeName: string
  attributeTypeId: number | string | null
  typeCreated: boolean
  shortName: string
  attributeId: number | string | null
  action: 'created' | 'existing'
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for attribute rollback' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  let deleted = 0
  let skipped = 0
  const typesCreated = new Set<string>()

  try {
    await withSession(base, credential, async (cookie) => {
      for (const entry of previous) {
        if (entry.typeCreated) typesCreated.add(entry.attributeTypeName)
        if (entry.action !== 'created' || entry.attributeId == null) {
          skipped++
          continue
        }
        try {
          await deletePath(base, `/Attributes/${encodeURIComponent(String(entry.attributeId))}`, cookie)
          deleted++
        } catch {
          skipped++
        }
      }
    })
    const note = typesCreated.size
      ? ` Attribute type(s) created by this deploy were left in place (never auto-deleted): ${[...typesCreated].join(', ')}.`
      : ''
    return {
      success: true,
      message: `Rolled back attributes: ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.${note}`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

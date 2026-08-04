import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { exclusionWriteBody, type ScopeExclusionAttributes } from './_shared'

/**
 * Undo a scope-exclusion deploy from rollbackData.previous (written by deploy()):
 *   - an exclusion that ALREADY EXISTED → PUT its prior attributes back.
 *   - an exclusion this deploy CREATED   → DELETE it (unlike Structured Scopes,
 *     Scope Exclusions have a genuine DELETE endpoint — no archive-vs-delete
 *     ambiguity here).
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  category: string
  exclusionId: string | null
  existed: boolean
  previousAttributes: Partial<ScopeExclusionAttributes> | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for scope-exclusion rollback' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.programId || !entry.exclusionId) {
      skipped++
      continue
    }
    const path = `/programs/${encodeURIComponent(entry.programId)}/scope_exclusions/${encodeURIComponent(entry.exclusionId)}`
    try {
      if (entry.existed && entry.previousAttributes) {
        const res = await client.put(path, exclusionWriteBody(entry.previousAttributes))
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`restore "${entry.category}" (${entry.programHandle}): ${error}`)
          continue
        }
        restored++
      } else {
        const res = await client.delete(path)
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`delete "${entry.category}" (${entry.programHandle}): ${error}`)
          continue
        }
        deleted++
      }
    } catch (error) {
      failures.push(`"${entry.category}" (${entry.programHandle}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  const summary = `${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}`
  if (failures.length > 0) {
    return { success: false, message: `Scope-exclusion rollback (${summary}); ${failures.length} error(s): ${failures.join('; ')}.` }
  }
  return { success: true, message: `Rolled back scope exclusions: ${summary}.` }
}

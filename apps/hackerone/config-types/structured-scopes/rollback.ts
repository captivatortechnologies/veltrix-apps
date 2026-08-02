import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { scopeWriteBody, type ScopeAttributes } from './_shared'

/**
 * Undo a structured-scope deploy from rollbackData.previous (written by deploy()):
 *   - a scope that ALREADY EXISTED → PUT its prior writable attributes back.
 *   - a scope this deploy CREATED   → archive it (PUT { archived: true }), so the
 *     asset is removed from the active program scope.
 *
 * FLAGGED — the program-level update/archive endpoints were removed from the
 * HackerOne docs on 2026-04-07; and the exact archive semantics (a PUT with
 * `archived: true` vs. a DELETE) must be verified against live HackerOne.
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  assetIdentifier: string
  scopeId: string | null
  existed: boolean
  previousAttributes: Partial<ScopeAttributes> | null
}

/** The writable subset to restore — read-only fields (reference, timestamps) are dropped. */
function restorableAttributes(prev: Partial<ScopeAttributes>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['asset_type', 'asset_identifier', 'eligible_for_bounty', 'eligible_for_submission', 'max_severity', 'instruction'] as const) {
    if (prev[key] !== undefined) out[key] = prev[key]
  }
  return out
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for structured-scope rollback' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let archived = 0
  let skipped = 0
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.programId || !entry.scopeId) {
      skipped++
      continue
    }
    const path = `/programs/${encodeURIComponent(entry.programId)}/structured_scopes/${encodeURIComponent(entry.scopeId)}`
    try {
      if (entry.existed && entry.previousAttributes) {
        const res = await client.put(path, scopeWriteBody(restorableAttributes(entry.previousAttributes)))
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`restore "${entry.assetIdentifier}" (${entry.programHandle}): ${error}`)
          continue
        }
        restored++
      } else {
        const res = await client.put(path, scopeWriteBody({ archived: true }))
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`archive "${entry.assetIdentifier}" (${entry.programHandle}): ${error}`)
          continue
        }
        archived++
      }
    } catch (error) {
      failures.push(`"${entry.assetIdentifier}" (${entry.programHandle}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  const summary = `${restored} restored, ${archived} archived${skipped ? `, ${skipped} skipped` : ''}`
  if (failures.length > 0) {
    return { success: false, message: `Structured-scope rollback (${summary}); ${failures.length} error(s): ${failures.join('; ')}.` }
  }
  return { success: true, message: `Rolled back structured scopes: ${summary}.` }
}

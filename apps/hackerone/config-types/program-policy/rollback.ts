import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { policyWriteBody } from './_shared'

/**
 * Undo a program-policy deploy from rollbackData.previous (written by deploy()):
 * restore the policy text captured immediately before the deploy overwrote it. A
 * program's policy is never "created" or "deleted" by this config type — only
 * ever replaced — so rollback is always a restore, never an archive.
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  previousPolicy: string | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for program-policy rollback' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let skipped = 0
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.programId || entry.previousPolicy === null) {
      skipped++
      continue
    }
    try {
      const res = await client.put(`/programs/${encodeURIComponent(entry.programId)}/policy`, policyWriteBody(entry.previousPolicy))
      const error = hackeroneWriteError(res)
      if (error) {
        failures.push(`restore "${entry.programHandle}": ${error}`)
        continue
      }
      restored++
    } catch (error) {
      failures.push(`"${entry.programHandle}": ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  const summary = `${restored} restored${skipped ? `, ${skipped} skipped (no prior text captured)` : ''}`
  if (failures.length > 0) {
    return { success: false, message: `Program-policy rollback (${summary}); ${failures.length} error(s): ${failures.join('; ')}.` }
  }
  return { success: true, message: `Rolled back program policy: ${summary}.` }
}

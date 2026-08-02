import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { inquiryWriteBody } from './_shared'

/**
 * Undo a credential-inquiry deploy from rollbackData.previous (written by deploy()):
 *   - an inquiry that ALREADY EXISTED → PUT its prior description back.
 *   - an inquiry this deploy CREATED   → DELETE it, so the program no longer
 *     requests credentials for that scope.
 *
 * FLAGGED — the credential-inquiry endpoints require the Team Management
 * permission on the API token. Verify against live HackerOne.
 *   Confirmed paths: https://api.hackerone.com/customer-resources/ (Credential Inquiries)
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  assetIdentifier: string
  structuredScopeId: string | null
  inquiryId: string | null
  existed: boolean
  previousDescription: string | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for credential-inquiry rollback' }
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
    if (!entry.programId || !entry.inquiryId) {
      skipped++
      continue
    }
    const path = `/programs/${encodeURIComponent(entry.programId)}/credential_inquiries/${encodeURIComponent(entry.inquiryId)}`
    const label = `${entry.programHandle}/${entry.assetIdentifier}`
    try {
      if (entry.existed && entry.previousDescription != null) {
        const res = await client.put(path, inquiryWriteBody(entry.previousDescription))
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`restore "${label}": ${error}`)
          continue
        }
        restored++
      } else {
        const res = await client.delete(path)
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`delete "${label}": ${error}`)
          continue
        }
        deleted++
      }
    } catch (error) {
      failures.push(`"${label}": ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  const summary = `${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}`
  if (failures.length > 0) {
    return { success: false, message: `Credential-inquiry rollback (${summary}); ${failures.length} error(s): ${failures.join('; ')}.` }
  }
  return { success: true, message: `Rolled back credential inquiries: ${summary}.` }
}

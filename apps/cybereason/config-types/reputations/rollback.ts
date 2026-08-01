import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  CLASSIFICATION_UPDATE_PATH,
} from '../../lib/cybereasonApi'
import { REPUTATIONS, type ClassificationEntry } from './_shared'

/**
 * Undo a reputations deploy from rollbackData.previous (written by deploy()): for
 * each entry, restore the prior verdict (POST classification/update, remove:false)
 * or — when the key had no custom reputation before — remove the one we added
 * (POST classification/update, remove:true). Applied over the Cybereason REST API.
 */
interface PreviousEntry {
  key: string
  applied: { maliciousType: string; prevent: boolean; comment: string }
  prior: { maliciousType: string; prevent: boolean; comment: string } | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for custom reputation rollback' }
  }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let restored = 0
  let removed = 0
  let skipped = 0
  try {
    const session = await createSession(base, credential, timeoutMs)

    for (const { key, applied, prior } of previous) {
      let entry: ClassificationEntry
      if (prior) {
        // Restore the prior verdict. If the prior verdict was not captured
        // (unknown malicious type), there is nothing safe to restore.
        if (!REPUTATIONS.has(prior.maliciousType)) {
          skipped++
          continue
        }
        entry = {
          keys: [key],
          maliciousType: prior.maliciousType as 'whitelist' | 'blacklist',
          prevent: prior.prevent,
          remove: false,
          ...(prior.comment ? { comment: prior.comment } : {}),
        }
      } else {
        // The key had no custom reputation before — remove the one we added.
        entry = {
          keys: [key],
          maliciousType: (REPUTATIONS.has(applied.maliciousType) ? applied.maliciousType : 'blacklist') as
            | 'whitelist'
            | 'blacklist',
          prevent: false,
          remove: true,
        }
      }

      const res = await session.postJson(CLASSIFICATION_UPDATE_PATH, [entry])
      if (!res.ok || looksLikeLoginPage(res.body)) {
        throw new Error(`classification/update → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
      }
      if (prior) restored++
      else removed++
    }

    return {
      success: true,
      message: `Rolled back custom reputations: ${restored} restored, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

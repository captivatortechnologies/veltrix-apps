import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { TAGGING_ENDPOINT, buildTagOpsFromSnapshot, buildProcessTagsBody, assertTagsApplied, type TagSnapshot } from './_shared'

/**
 * Undo a sensor-tag deploy from rollbackData.previous (written by deploy): each
 * tag is restored to its prior value, or REMOVED when it had no value before —
 * applied over the same POST /rest/tagging/process_tags endpoint used by deploy.
 */
interface PreviousTagSet {
  pylumId: string
  prior: TagSnapshot | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousTagSet[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for sensor-tag rollback' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let restored = 0
  try {
    const session = await createSession(base, credential, timeoutMs)

    for (const { pylumId, prior } of previous) {
      const ops = buildTagOpsFromSnapshot(prior)
      const res = await session.postJson(TAGGING_ENDPOINT, buildProcessTagsBody(pylumId, ops))
      if (!res.ok || looksLikeLoginPage(res.body)) {
        throw new Error(`tagging/process_tags (restore) → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
      }
      assertTagsApplied(res.body, pylumId)
      restored++
    }

    return { success: true, message: `Rolled back tags for ${restored} sensor(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed after ${restored} sensor(s): ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

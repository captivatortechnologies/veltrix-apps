import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { ISOLATION_ENDPOINTS, rulesFromResponse, indexByIdentity, type IsolationRule } from './_shared'

/**
 * Undo an isolation-rule deploy from rollbackData.previous (written by deploy):
 * rules that existed before are RESTORED to their prior values; rules this deploy
 * CREATED are DELETED. Both write paths need the CURRENT ruleId + lastUpdated (the
 * concurrency token moves on every write), so rollback re-reads the live rules and
 * reconciles by the composite identity before writing.
 */
interface PreviousRule {
  identity: string
  prior: IsolationRule | null
  createdRuleId: string | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousRule[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for isolation-rule rollback' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let restored = 0
  let removed = 0
  let skipped = 0
  try {
    const session = await createSession(base, credential, timeoutMs)
    const res0 = await session.get(ISOLATION_ENDPOINTS.list)
    const liveIndex =
      res0.ok && !looksLikeLoginPage(res0.body)
        ? indexByIdentity(rulesFromResponse(res0.body))
        : new Map<string, IsolationRule>()

    for (const { identity, prior } of previous) {
      const live = liveIndex.get(identity) ?? null
      if (prior) {
        // Restore the prior values, carrying the CURRENT ruleId + lastUpdated.
        const body: IsolationRule = {
          ruleId: live?.ruleId ?? prior.ruleId ?? null,
          ipAddressString: prior.ipAddressString,
          port: prior.port,
          blocking: prior.blocking,
          direction: prior.direction,
          ...(live?.lastUpdated !== undefined ? { lastUpdated: live.lastUpdated } : {}),
        }
        const res = await session.putJson(ISOLATION_ENDPOINTS.update, body)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`isolation-rule PUT (restore) → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        restored++
      } else if (live) {
        // The rule did not exist before — delete the one we created.
        const res = await session.postJson(ISOLATION_ENDPOINTS.remove, live)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`isolation-rule delete → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        removed++
      } else {
        // Nothing live to restore or delete (already gone) — skip.
        skipped++
      }
    }

    return {
      success: true,
      message: `Rolled back isolation rules: ${restored} restored, ${removed} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

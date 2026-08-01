import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

/**
 * Activation is a FORWARD-ONLY action, so there is nothing to programmatically
 * undo. The public Network Lists API v2 exposes an `activate` endpoint and a
 * `status` endpoint, but NO deactivation endpoint — a list that has gone live on
 * STAGING/PRODUCTION cannot be pulled back to a prior syncPoint through this API.
 *
 * Rather than pretend otherwise, rollback is a truthful no-op: it reports what
 * the deploy activated (from `rollbackData.previous`) and how to revert manually
 * (re-activate a prior syncPoint, or deactivate the list in Control Center). It
 * always succeeds so it never blocks a pipeline that legitimately has no
 * automatic reversal.
 */

interface PriorEntry {
  networkListName: string
  network: string
  uniqueId: string
  priorStatus: string | null
  priorSyncPoint: number | null
  outcome: string
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []

  const triggered = previous.filter((p) => p.outcome === 'activated')
  if (triggered.length === 0) {
    return { success: true, message: 'Nothing to roll back — no activations were triggered by this deploy.' }
  }

  const targets = triggered.map((p) => `${p.networkListName} → ${p.network}`).join(', ')
  return {
    success: true,
    message:
      `Activation is forward-only and cannot be reverted through the Network Lists API. ` +
      `${triggered.length} activation(s) were triggered (${targets}). To revert, re-activate a ` +
      `prior syncPoint or deactivate the list(s) in Akamai Control Center.`,
  }
}

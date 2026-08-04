import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage, type CybereasonSession } from '../../lib/cybereasonApi'
import { POLICY_ENDPOINTS, policiesFromResponse, policyDetailFromResponse, type PolicyListRow } from './_shared'

/**
 * Undo a sensor-policy deploy from rollbackData.previous (written by deploy):
 * policies that existed before are RESTORED (PUT their prior `configuration`,
 * itself UNVERIFIED — see _shared.ts); policies this deploy CREATED are DELETED
 * by GUID, reassigning their sensors to the tenant's default policy.
 */
interface PreviousPolicy {
  name: string
  id: string | null
  prior: Record<string, unknown> | null
}

/**
 * Best-effort discovery of the tenant's default policy id (needed as the
 * `assignToPolicyId` reassignment target on delete — unlike Groups, there is no
 * fixed sentinel GUID for "the default policy"). Scans a bounded number of
 * policies' full detail (the `isDefault` flag only appears on GET /policies/{id},
 * not the lightweight list row) and returns the first default found.
 */
async function findDefaultPolicyId(session: CybereasonSession, rows: PolicyListRow[]): Promise<string | null> {
  const candidates = rows.filter((r) => r.id).slice(0, 25)
  for (const row of candidates) {
    try {
      const res = await session.get(POLICY_ENDPOINTS.get(String(row.id)))
      if (!res.ok || looksLikeLoginPage(res.body)) continue
      const detail = policyDetailFromResponse(res.body)
      if (detail?.metadata?.isDefault) return String(row.id)
    } catch {
      // keep scanning
    }
  }
  return null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousPolicy[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for sensor-policy rollback' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let restored = 0
  let removed = 0
  let skipped = 0
  try {
    const session = await createSession(base, credential, timeoutMs)

    // Resolve a default-policy reassignment target once, only if this rollback
    // needs to delete a created policy.
    let defaultPolicyId: string | null | undefined
    const resolveDefault = async () => {
      if (defaultPolicyId !== undefined) return defaultPolicyId
      const listRes = await session.get(POLICY_ENDPOINTS.list)
      const rows = listRes.ok && !looksLikeLoginPage(listRes.body) ? policiesFromResponse(listRes.body) : []
      defaultPolicyId = await findDefaultPolicyId(session, rows)
      return defaultPolicyId
    }

    for (const { id, prior } of previous) {
      if (prior) {
        if (!id) {
          skipped++
          continue
        }
        const res = await session.putJson(POLICY_ENDPOINTS.update(id), prior)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`policies PUT (restore) → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        restored++
      } else if (id) {
        const assignTo = await resolveDefault()
        if (!assignTo) {
          skipped++
          continue
        }
        const res = await session.del(POLICY_ENDPOINTS.remove(id, assignTo))
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`policies DELETE → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        removed++
      } else {
        skipped++
      }
    }

    return {
      success: true,
      message:
        `Rolled back sensor policies: ${restored} restored, ${removed} deleted` +
        `${skipped ? `, ${skipped} skipped (id or default policy could not be resolved)` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

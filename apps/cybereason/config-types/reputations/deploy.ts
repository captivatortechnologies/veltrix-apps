import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  CLASSIFICATION_UPDATE_PATH,
  CLASSIFICATION_DOWNLOAD_PATH,
  type CybereasonSession,
} from '../../lib/cybereasonApi'
import { buildEntry, parseReputationsCsv, indexByKey, normalizeKey, type ReputationRow } from './_shared'

/**
 * Deploy Cybereason custom reputations over the REST API:
 *   read (rollback): GET  /rest/classification/download  → snapshot prior verdicts
 *   upsert:          POST /rest/classification/update     with [{ keys, maliciousType, prevent, remove:false }]
 *
 * classification/update IS an upsert — one POST sets or overwrites the verdict
 * for a key — so there is no separate create vs edit path. The key is the stable
 * identity. rollbackData records, per key, the entry we applied AND the prior
 * verdict (null when the key had no custom reputation) so rollback can restore
 * the prior verdict or remove the one we added.
 */

/** Read every current custom reputation (best-effort) for prior-state snapshots. */
async function downloadReputations(session: CybereasonSession): Promise<ReputationRow[]> {
  try {
    const res = await session.get(CLASSIFICATION_DOWNLOAD_PATH)
    if (!res.ok || looksLikeLoginPage(res.body)) return []
    return parseReputationsCsv(res.body)
  } catch {
    return []
  }
}

interface PriorState {
  maliciousType: string
  prevent: boolean
  comment: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for custom reputation deployment' }
  }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  const previous: Array<{
    key: string
    applied: { maliciousType: string; prevent: boolean; comment: string }
    prior: PriorState | null
  }> = []
  const applied: string[] = []

  try {
    const session = await createSession(base, credential, timeoutMs)
    const priorIndex = indexByKey(await downloadReputations(session))

    for (const item of items) {
      const keyType = String(item.fields.keyType ?? '').trim()
      const rawKey = String(item.fields.key ?? '').trim()
      if (!rawKey || !keyType) continue

      const entry = buildEntry(item.fields, false)
      const priorRow = priorIndex.get(normalizeKey(keyType, rawKey).toLowerCase()) ?? null

      const res = await session.postJson(CLASSIFICATION_UPDATE_PATH, [entry])
      if (!res.ok || looksLikeLoginPage(res.body)) {
        throw new Error(`classification/update → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
      }

      previous.push({
        key: entry.keys[0],
        applied: { maliciousType: entry.maliciousType, prevent: entry.prevent, comment: entry.comment ?? '' },
        prior: priorRow
          ? { maliciousType: priorRow.reputation, prevent: priorRow.prevent, comment: priorRow.comment }
          : null,
      })
      applied.push(rawKey)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom reputation(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom reputation deploy failed after ${applied.length} item(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

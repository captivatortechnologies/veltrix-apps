import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  CLASSIFICATION_DOWNLOAD_PATH,
} from '../../lib/cybereasonApi'
import { parseReputationsCsv, indexByKey, buildEntry, normalizeKey } from './_shared'

/**
 * Drift for custom reputations: compare the verdict (and prevent flag) we declare
 * against the live reputation in Cybereason. Best-effort — a key that can't be
 * read is skipped rather than raising false drift. Read-only:
 * GET /rest/classification/download.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let index
  try {
    const session = await createSession(base, credential, timeoutMs)
    const res = await session.get(CLASSIFICATION_DOWNLOAD_PATH)
    if (!res.ok || looksLikeLoginPage(res.body)) return { hasDrift: false, diffs }
    index = indexByKey(parseReputationsCsv(res.body))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read reputations, no drift asserted
  }

  for (const item of items) {
    const keyType = String(item.fields.keyType ?? '').trim()
    const rawKey = String(item.fields.key ?? '').trim()
    if (!keyType || !rawKey) continue

    const entry = buildEntry(item.fields, false)
    const live = index.get(normalizeKey(keyType, rawKey).toLowerCase())
    if (!live) {
      diffs.push({ field: `${rawKey}.reputation`, expected: entry.maliciousType, actual: '(absent)', severity: 'critical' })
      continue
    }

    if (live.reputation && live.reputation !== entry.maliciousType) {
      diffs.push({ field: `${rawKey}.reputation`, expected: entry.maliciousType, actual: live.reputation, severity: 'warning' })
    }
    if (live.prevent !== entry.prevent) {
      diffs.push({ field: `${rawKey}.preventExecution`, expected: entry.prevent, actual: live.prevent, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

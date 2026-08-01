import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { ISOLATION_ENDPOINTS, rulesFromResponse, indexByIdentity, ruleIdentity, normalizeBool } from './_shared'

/**
 * Drift for isolation rules: the composite identity (ip + direction + port) locates
 * the live rule; a declared rule that is absent is drift. When present, the only
 * mutable attribute is `blocking`, so that is what is compared. Read is real
 * (GET /rest/settings/isolation-rule). Best-effort — an unreadable list asserts no drift.
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
    const res = await session.get(ISOLATION_ENDPOINTS.list)
    if (!res.ok || looksLikeLoginPage(res.body)) return { hasDrift: false, diffs }
    index = indexByIdentity(rulesFromResponse(res.body))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const ip = String(item.fields.ipAddressString ?? '').trim()
    if (!ip) continue
    const identity = ruleIdentity(item.fields)
    const live = index.get(identity)
    if (!live) {
      diffs.push({ field: identity, expected: 'present', actual: '(absent)', severity: 'critical' })
      continue
    }
    const expected = normalizeBool(item.fields.blocking)
    if (Boolean(live.blocking) !== expected) {
      diffs.push({ field: `${identity}.blocking`, expected, actual: Boolean(live.blocking), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

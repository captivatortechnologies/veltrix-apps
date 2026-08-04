import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { POLICY_ENDPOINTS, policiesFromResponse, policyDetailFromResponse, findPolicyByName, buildPolicyBody, diffDeclaredKeys } from './_shared'

/**
 * Drift for sensor policies: compare every key actually DECLARED in the
 * authored `configuration` (at any nesting depth) against the live policy's
 * `configuration` in Cybereason — not a fixed whitelist, so any authored field
 * is checked (same technique as Cisco Meraki's singleton `projectDeclared`).
 * Read-only: GET /rest/policies (list) + GET /rest/policies/{id} (detail).
 * Best-effort — a policy that can't be read is skipped rather than raising
 * false drift; a declared policy that is absent is flagged critical.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  try {
    const session = await createSession(base, credential, timeoutMs)
    const listRes = await session.get(POLICY_ENDPOINTS.list)
    if (!listRes.ok || looksLikeLoginPage(listRes.body)) return { hasDrift: false, diffs }
    const rows = policiesFromResponse(listRes.body)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const match = findPolicyByName(rows, name)
      if (!match?.id) {
        diffs.push({ field: name, expected: 'present', actual: '(absent)', severity: 'critical' })
        continue
      }

      const detailRes = await session.get(POLICY_ENDPOINTS.get(match.id))
      if (!detailRes.ok || looksLikeLoginPage(detailRes.body)) continue // best-effort: skip, no false drift
      const detail = policyDetailFromResponse(detailRes.body)
      if (!detail) continue

      const declared = buildPolicyBody(item.fields)
      const fieldDiffs = diffDeclaredKeys(declared, detail.configuration ?? {})
      for (const d of fieldDiffs) {
        diffs.push({ field: `${name}.${d.path}`, expected: d.expected, actual: d.actual, severity: 'warning' })
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read policies, no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}

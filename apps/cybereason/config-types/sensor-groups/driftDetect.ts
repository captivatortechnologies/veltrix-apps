import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage } from '../../lib/cybereasonApi'
import { GROUP_ENDPOINTS, groupsFromResponse, findGroupByName } from './_shared'

/**
 * Drift for sensor groups: compare the description + policyId we declare against
 * the live group in Cybereason. Read is real (GET /rest/groups). Best-effort — a
 * group that can't be read is skipped rather than raising false drift; a declared
 * group that is absent is flagged critical. The opaque groupAssignRule is not
 * diffed (its inner shape is unverified / FLAGGED).
 */
const COMPARED_FIELDS: Array<'description' | 'policyId'> = ['description', 'policyId']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  let live
  try {
    const session = await createSession(base, credential, timeoutMs)
    const res = await session.get(GROUP_ENDPOINTS.list)
    if (!res.ok || looksLikeLoginPage(res.body)) return { hasDrift: false, diffs }
    live = groupsFromResponse(res.body)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findGroupByName(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'present', actual: '(absent)', severity: 'critical' })
      continue
    }
    for (const field of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim()
      if (!expected) continue // an optional field the author left blank is not asserted
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (actual !== expected) {
        diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
